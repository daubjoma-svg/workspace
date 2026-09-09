#!/usr/bin/env bash
# Task 2 端到端验证（B2 / AC-09 / AC-10）：走真实 HTTP 提交需求 -> 引擎跑 AI 节点 ->
# 断言 ai_tasks 落行 + artifacts.meta 契约 + code_basis 为真实快照。
#
# 关键点：engine.js 之前只解构 {content, model}，meta 全丢，导致 B2 不可观测、
# AC-09 拿不到模型名/代码依据、AC-10 前端无法提示 mock。这里验证这条链已经通了。
#
# 需要一个桩 LLM（scripts/stub-llm.js）提供可控的成功响应，
# 因为 QA 库里的 provider 密文与当前 SOP_MASTER_KEY 不匹配（no_api_key），只会走 mock 分支。
#
# 用法：cd server && bash scripts/verify-ai-observability.sh

set -uo pipefail
# 必须与正在运行的服务用同一把 master key，否则桩密钥写进去服务解不开 -> 走 mock 分支，测了个寂寞
if [ -z "${SOP_MASTER_KEY:-}" ] && [ -f /tmp/sop_key.txt ]; then
  SOP_MASTER_KEY=$(cat /tmp/sop_key.txt); export SOP_MASTER_KEY
fi
[ -z "${SOP_MASTER_KEY:-}" ] && { echo "需要 SOP_MASTER_KEY（与运行中的服务一致）"; exit 1; }
BASE="${BASE:-http://localhost:4000/api/v1}"
BODY=/tmp/sop_obs_body.json
STUB_PORT=4600
PASS=0; FAIL=0

api() { local m="$1" p="$2" t="$3" b="${4:-}"
  if [ -n "$b" ]; then curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H 'content-type: application/json' -H "x-token: $t" -d "$b"
  else curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H "x-token: $t"; fi; }
check() { if [ "$1" = "$2" ]; then PASS=$((PASS+1)); printf 'PASS  %-52s %s\n' "$3" "$2"
  else FAIL=$((FAIL+1)); printf 'FAIL  %-52s got=%s want=%s\n' "$3" "$2" "$1"; fi; }
login() { curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).token;if(!t){console.error(s);process.exit(1)}console.log(t)})"; }

echo '=============================================================='
echo ' Task 2 端到端：B2 ai_tasks / AC-09 code_basis / AC-10 is_mock'
echo '=============================================================='

node scripts/stub-llm.js $STUB_PORT & STUB_PID=$!
sleep 0.8
trap 'kill $STUB_PID 2>/dev/null; node -e "
const {db}=require(\"$PWD/src/db\");
db.prepare(\"DELETE FROM ai_providers WHERE name=?\").run(\"__obs_stub__\");
db.prepare(\"UPDATE ai_providers SET enabled=1 WHERE id=2\").run();" 2>/dev/null' EXIT

# 桩 provider 独占 enabled（密钥用当前进程的 master key 加密，保证能解出来）
node -e "
const {db}=require('$PWD/src/db');
const secret=require('$PWD/src/crypto/secret');
db.prepare('UPDATE ai_providers SET enabled=0').run();
db.prepare('DELETE FROM ai_providers WHERE name=?').run('__obs_stub__');
db.prepare(\`INSERT INTO ai_providers(name,type,base_url,api_key_enc,model,enabled,capability,timeout_ms)
  VALUES(?,?,?,?,?,1,?,?)\`).run('__obs_stub__','openai-compat','http://127.0.0.1:$STUB_PORT',
  secret.encrypt('stub-key'),'stub-model-v9','json_object',5000);
console.log('  桩 provider 已装载 -> http://127.0.0.1:$STUB_PORT');
"

CSM=$(login csm01 123456) || exit 1
ADMIN=$(login admin admin123) || exit 1
MAPPING=$(node -e "const {db}=require('$PWD/src/db');
console.log(db.prepare(\"SELECT mm.id FROM module_mappings mm JOIN code_modules cm ON cm.id=mm.code_module_id WHERE cm.sync_status='OK' LIMIT 1\").get().id)")

CODE=$(api POST /requirements "$CSM" "{\"title\":\"B2 可观测性端到端验证\",\"description\":\"验证 AI 节点执行后 ai_tasks 落行且 artifact.meta 契约完整的需求描述。\",\"customer_name\":\"内部\",\"priority\":\"P1\",\"module_ids\":[$MAPPING]}")
RID=$(node -e "console.log(require('$BODY').id)")
check 200 "$CODE" "1. 创建需求 RID=$RID"

CODE=$(api POST "/requirements/$RID/submit" "$CSM" '{}')
check 200 "$CODE" "2. 提交需求(进入 seq1 CSM 人工节点)"

# seq1 是 CSM 人工节点，确认后才流转到 seq2 的 AI·需求评审
CODE=$(api POST "/requirements/$RID/confirm" "$CSM" '{"comment":"确认提交"}')
check 200 "$CODE" "2a. 确认 CSM 节点(流转到 seq2 AI 节点)"
sleep 3

echo
echo '---------- B2  ai_tasks 落行 ----------'
node -e "
const {db}=require('$PWD/src/db');
const rows=db.prepare('SELECT * FROM ai_tasks WHERE requirement_id=? ORDER BY id').all($RID);
console.log('  ai_tasks 行数='+rows.length);
rows.forEach(r=>console.log('  -> '+JSON.stringify({action:r.action,status:r.status,model:r.model,is_mock:r.is_mock,latency_ms:r.latency_ms,attempt:r.attempt,pt:r.prompt_tokens,ct:r.completion_tokens,level:r.structured_level})));
require('fs').writeFileSync('/tmp/sop_obs_rows.json',JSON.stringify(rows));
"
ROWS=$(node -e "console.log(require('/tmp/sop_obs_rows.json').length)")
[ "$ROWS" -ge 1 ] && { PASS=$((PASS+1)); printf 'PASS  %-52s %s 行\n' "3. ai_tasks 已写入(修复前恒为 0)" "$ROWS"; } \
  || { FAIL=$((FAIL+1)); printf 'FAIL  %-52s 无记录\n' "3. ai_tasks 已写入"; }

MODEL=$(node -e "console.log(require('/tmp/sop_obs_rows.json')[0]?.model||'')")
check "stub-model-v9" "$MODEL" "4. AC-09 记录真实模型名(非 mock)"

ISMOCK=$(node -e "console.log(require('/tmp/sop_obs_rows.json')[0]?.is_mock)")
check 0 "$ISMOCK" "5. AC-10 真实模型 is_mock=0"

LAT=$(node -e "const r=require('/tmp/sop_obs_rows.json')[0]||{};console.log(Number.isInteger(r.latency_ms)&&r.latency_ms>0?'real':String(r.latency_ms))")
check "real" "$LAT" "6. latency_ms 为真实耗时(非 0 占位)"

TOK=$(node -e "const r=require('/tmp/sop_obs_rows.json')[0]||{};console.log(r.prompt_tokens>0&&r.completion_tokens>0?'ok':r.prompt_tokens+'/'+r.completion_tokens)")
check "ok" "$TOK" "7. token 用量已记录"

echo
echo '---------- AC-09 / AC-10  artifacts.meta 契约 ----------'
node -e "
const {db}=require('$PWD/src/db');
const a=db.prepare('SELECT id,kind,created_by,meta FROM artifacts WHERE requirement_id=? ORDER BY id DESC LIMIT 1').get($RID);
console.log('  artifact.kind = '+(a&&a.kind)+' / created_by = '+(a&&a.created_by));
console.log('  artifact.meta = '+(a&&a.meta));
require('fs').writeFileSync('/tmp/sop_obs_art.json',JSON.stringify(a||{}));
"
HASMETA=$(node -e "const a=require('/tmp/sop_obs_art.json');console.log(a.meta?'ok':'null')")
check "ok" "$HASMETA" "8. artifacts.meta 非空(修复前恒为 null)"

KEYS=$(node -e "
const a=require('/tmp/sop_obs_art.json');
const k=Object.keys(JSON.parse(a.meta||'{}')).sort().join(',');
console.log(k);")
check "attempt,code_basis,degraded_reason,is_mock,latency_ms,model,provider_id,provider_type,status,structured_level" "$KEYS" "9. meta 锁定契约 10 字段"

CB=$(node -e "
const a=require('/tmp/sop_obs_art.json');
const cb=JSON.parse(a.meta||'{}').code_basis;
const m=cb&&cb.modules&&cb.modules[0];
console.log(m&&m.module_key&&m.branch&&m.commit&&Number.isFinite(m.file_count)?'real':JSON.stringify(cb));")
check "real" "$CB" "10. AC-09 code_basis 为真实快照(非占位)"
node -e "const a=require('/tmp/sop_obs_art.json');console.log('      code_basis = '+JSON.stringify(JSON.parse(a.meta||'{}').code_basis))"

BY=$(node -e "console.log(require('/tmp/sop_obs_art.json').created_by||'')")
check "AI(stub-model-v9)" "$BY" "10a. AC-09 产物署名带真实模型名"

echo
echo '---------- AC-10  mock 内容不得冒用真实模型名 ----------'
# 陷阱：mock 分支的 meta.model 仍是配置里的模型名(deepseek-chat)，
# 若署名只取 meta.model，假数据会被署成真模型 -> 前端判不出 mock。必须署 AI(mock)。
node -e "
process.env.SOP_MASTER_KEY=require('fs').readFileSync('/tmp/sop_key.txt','utf8').trim();
const {db}=require('$PWD/src/db');
db.prepare('UPDATE ai_providers SET enabled=0 WHERE name=?').run('__obs_stub__');
db.prepare('UPDATE ai_providers SET enabled=1 WHERE id=2').run();   // 密文解不开 -> 必走 mock
const {runAI}=require('$PWD/src/ai');
runAI('EVALUATE',{id:0,title:'t',description:'d'.repeat(30),customer_name:'c',priority:'P2',module_ids:''}).then(r=>{
  const meta=r.meta;
  const by = meta && meta.is_mock ? 'AI(mock)' : 'AI('+((meta&&meta.model)||r.model)+')';
  console.log(JSON.stringify({is_mock:meta.is_mock, meta_model:meta.model, by}));
  require('fs').writeFileSync('/tmp/sop_obs_mock.json',JSON.stringify({is_mock:meta.is_mock,by}));
});" >/tmp/sop_obs_mock_log.txt 2>&1
sleep 0.5
printf '      -> %s\n' "$(grep '^{' /tmp/sop_obs_mock_log.txt | head -1)"
MBY=$(node -e "console.log(require('/tmp/sop_obs_mock.json').by)")
check "AI(mock)" "$MBY" "10b. mock 产物署名为 AI(mock) 而非真实模型名"
MIS=$(node -e "console.log(require('/tmp/sop_obs_mock.json').is_mock)")
check "true" "$MIS" "10c. mock 分支 is_mock=true"

echo
echo '---------- 端点可查（前端 AC-10 提示的数据来源）----------'
CODE=$(api GET "/admin/ai-tasks?requirement_id=$RID" "$ADMIN")
check 200 "$CODE" "11. GET /admin/ai-tasks?requirement_id -> 200"
TOTAL=$(node -e "console.log(require('$BODY').data.total)")
[ "$TOTAL" -ge 1 ] && { PASS=$((PASS+1)); printf 'PASS  %-52s total=%s\n' "12. 端点可查到该需求的 AI 调用" "$TOTAL"; } \
  || { FAIL=$((FAIL+1)); printf 'FAIL  %-52s total=%s\n' "12. 端点可查到该需求的 AI 调用" "$TOTAL"; }

echo
echo '=============================================================='
echo " 结果: PASS=$PASS  FAIL=$FAIL"
echo '=============================================================='
[ "$FAIL" -eq 0 ] || exit 1
