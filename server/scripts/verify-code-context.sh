#!/usr/bin/env bash
# Task 3 回归验证：AC-12 code-context 回显 + B6 敏感文件不外泄 + module_key 正则收口 + B2 /ai-tasks。
#
# QA 在 data/repos/qatestrepo 埋了 8 个 canary：
#   001-003 application.properties / 004 application-prod.yml / 005 .env
#   006 config/secrets/prod.yml    / 007-008 UserController.java 行内明文
# 前 6 个所在文件必须被 L1 isSensitiveFile 整体剔除（连文件名都不许出现）；
# 007/008 所在文件是正常业务代码，必须注入，但明文必须被 L2 redactSecrets 打码。
#
# 用法：
#   cd server
#   SOP_MASTER_KEY=$(cat /tmp/sop_key.txt) node src/index.js &
#   bash scripts/verify-code-context.sh
#
# 退出码：0 全绿；1 有断言失败。

set -uo pipefail
BASE="${BASE:-http://localhost:4000/api/v1}"
BODY=/tmp/sop_cc_body.json
PASS=0; FAIL=0

api() { # method path token [json-body]
  local m="$1" p="$2" t="$3" b="${4:-}"
  if [ -n "$b" ]; then
    curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H 'content-type: application/json' -H "x-token: $t" -d "$b"
  else
    curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H "x-token: $t"
  fi
}
check() { # expected actual label
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); printf 'PASS  %-56s %s\n' "$3" "$2"
  else FAIL=$((FAIL+1)); printf 'FAIL  %-56s got=%s want=%s body=%s\n' "$3" "$2" "$1" "$(head -c 220 "$BODY")"; fi
}
show() { printf '      -> %s\n' "$(head -c 300 "$BODY")"; }

login() {
  curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).token;if(!t){console.error('login failed: '+s);process.exit(1)}console.log(t)})"
}

echo '=============================================================='
echo ' Task 3 验证：AC-12 code-context / B6 敏感文件 / module_key / ai-tasks'
echo '=============================================================='

ADMIN=$(login admin admin123)   || exit 1
CSM=$(login csm01 123456)       || exit 1
[ -z "$ADMIN" ] && { echo "admin 登录失败"; exit 1; }

# ---------- 准备：建需求并挂上 qatestrepo（sync_status=OK 的唯一模块）----------
MAPPING=$(node -e "
const {db}=require('$PWD/src/db');
const r=db.prepare(\"SELECT mm.id FROM module_mappings mm JOIN code_modules cm ON cm.id=mm.code_module_id WHERE cm.sync_status='OK' LIMIT 1\").get();
console.log(r?r.id:'');")
echo "  使用 mapping_id=$MAPPING (qatestrepo, sync_status=OK)"

CODE=$(api POST /requirements "$CSM" "{\"title\":\"AC-12 代码上下文回显验证\",\"description\":\"用于验证 code-context 端点不泄漏敏感文件的需求描述文本。\",\"customer_name\":\"内部\",\"priority\":\"P2\",\"module_ids\":[$MAPPING]}")
RID=$(node -e "console.log(require('$BODY').id||require('$BODY').data?.id||'')")
check 200 "$CODE" "准备: 创建需求(挂 qatestrepo) RID=$RID"
LINKED=$(node -e "
const {db}=require('$PWD/src/db');
console.log(db.prepare('SELECT COUNT(*) c FROM requirement_modules WHERE requirement_id=?').get($RID).c);")
check 1 "$LINKED" "准备: requirement_modules 关联已写入"

echo
echo '---------- AC-12  GET /requirements/:id/code-context ----------'
CODE=$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/requirements/$RID/code-context")
check 401 "$CODE" "1. 未登录访问 -> 401"

CODE=$(api GET "/requirements/$RID/code-context" "$CSM")
check 200 "$CODE" "2. 登录后访问 -> 200"
show

CODE=$(api GET "/requirements/999999/code-context" "$CSM")
check 404 "$CODE" "3. 不存在的需求 -> 404"

CODE=$(api GET "/requirements/abc/code-context" "$CSM")
check 400 "$CODE" "4. 非法 ID -> 400"

# ---------- B6：敏感文件与 canary 明文都不许出现在响应里 ----------
echo
echo '---------- B6  敏感文件/明文泄漏检查（响应体全文扫描）----------'
api GET "/requirements/$RID/code-context" "$CSM" >/dev/null
RAW=$(cat "$BODY")

for pat in '.env' 'application.properties' 'application-prod.yml' 'secrets/prod.yml'; do
  if echo "$RAW" | grep -qF -- "$pat"; then
    FAIL=$((FAIL+1)); printf 'FAIL  %-56s 敏感文件名出现在响应中!\n' "5. 不含敏感文件名 [$pat]"
  else
    PASS=$((PASS+1)); printf 'PASS  %-56s 未出现\n' "5. 不含敏感文件名 [$pat]"
  fi
done

for c in CANARY_001 JWT_CANARY_002 REDIS_CANARY_003 AWS_CANARY_004 ENV_CANARY_005 SECRETS_DIR_CANARY_006 INLINE_CANARY_007 INLINE_CANARY_008 AKIAIOSFODNN7EXAMPLE ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789; do
  if echo "$RAW" | grep -qF -- "$c"; then
    FAIL=$((FAIL+1)); printf 'FAIL  %-56s canary 泄漏!\n' "6. 响应不含明文 [$c]"
  else
    PASS=$((PASS+1)); printf 'PASS  %-56s 未泄漏\n' "6. 响应不含明文 [$c]"
  fi
done

if echo "$RAW" | grep -qF 'UserController.java'; then
  PASS=$((PASS+1)); printf 'PASS  %-56s 正常业务文件已回显\n' "7. 含正常代码文件 UserController.java"
else
  FAIL=$((FAIL+1)); printf 'FAIL  %-56s 正常文件缺失(过滤过度)\n' "7. 含正常代码文件 UserController.java"
fi

HASCONTENT=$(node -e "
const d=require('$BODY').data||{};
const f=(d.modules||[]).flatMap(m=>m.files||[]);
console.log(f.length && f.every(x=>x.content===undefined) ? 'no-content' : (f.length?'HAS-CONTENT':'empty'));")
check "no-content" "$HASCONTENT" "8. 只回路径+字符数，不回文件内容"

echo
echo '---------- B6  同一条过滤链：注入 LLM 的 prompt 也不许带明文 ----------'
node -e "
const {buildCodeContext}=require('$PWD/src/repo');
const ctx=buildCodeContext([$MAPPING],{withFiles:true,maxFiles:6});
const blob=JSON.stringify(ctx);
const canaries=['CANARY_001','JWT_CANARY_002','REDIS_CANARY_003','AWS_CANARY_004','ENV_CANARY_005','SECRETS_DIR_CANARY_006','INLINE_CANARY_007','INLINE_CANARY_008'];
let bad=canaries.filter(c=>blob.includes(c));
const files=(ctx.modules||[]).flatMap(m=>(m.key_files||[]).map(f=>f.path));
console.log('   注入文件清单: '+JSON.stringify(files));
console.log('   目录树条目: '+((ctx.modules||[])[0]?.tree||'').split('\n').filter(Boolean).length);
if(bad.length){console.log('LEAK '+bad.join(','));process.exit(1)}
console.log('CLEAN');
" > /tmp/sop_cc_llm.txt 2>&1
grep -q CLEAN /tmp/sop_cc_llm.txt && { PASS=$((PASS+1)); printf 'PASS  %-56s prompt 内无明文\n' "9. buildCodeContext 产物已脱敏"; } \
  || { FAIL=$((FAIL+1)); printf 'FAIL  %-56s %s\n' "9. buildCodeContext 产物已脱敏" "$(cat /tmp/sop_cc_llm.txt)"; }
sed -n '1,3p' /tmp/sop_cc_llm.txt | grep '   ' || true

# ---------- module_key 正则收口 ----------
echo
echo '---------- AC/B4  module_key 正则统一到 paths.js 严格式 ----------'
mk_post() { api POST /admin/modules "$ADMIN" "{\"module_key\":\"$1\",\"name\":\"t\",\"gitlab_project_id\":\"123\",\"gitlab_project_path\":\"g/p\",\"branch\":\"main\"}"; }

# QA 库里的 MyModule / aaaa...(100字符) 正是旧 /i 正则漏进来的存量脏数据，这里验证同样输入现在建不进去
check 400 "$(mk_post 'MyModule')"        "10. 大写 module_key -> 400 (复现 QA 脏数据入口)"
check 400 "$(mk_post "$(printf 'a%.0s' {1..100})")" "11. 超长(100字符) module_key -> 400"
check 400 "$(mk_post '-lead-dash')"      "12. 连字符开头 -> 400"
check 400 "$(mk_post 'has space')"       "13. 含空格 -> 400"
check 400 "$(mk_post '../etc')"          "14. 路径穿越 -> 400"
check 400 "$(mk_post '')"                "15. 空值 -> 400"

OKKEY="vk$(date +%s)"
CODE=$(mk_post "$OKKEY")
check 200 "$CODE" "16. 合法 module_key -> 200"
NEWID=$(node -e "const d=require('$BODY');console.log(d.id||d.data?.id||'')")

# PUT 不接受 module_key（建后不可变），传了只会被忽略，写不脏
CODE=$(api PUT "/admin/modules/$NEWID" "$ADMIN" '{"module_key":"BadCase","name":"t2"}')
check 200 "$CODE" "17. PUT 传 module_key -> 200 (字段被忽略)"
KEEP=$(node -e "
const {db}=require('$PWD/src/db');
console.log(db.prepare('SELECT module_key FROM code_modules WHERE id=?').get($NEWID)?.module_key||'');")
check "$OKKEY" "$KEEP" "17a. module_key 未被 PUT 改写(不可变)"

CODE=$(api PUT "/admin/modules/$NEWID" "$ADMIN" '{"name":"t3","sub_path":"../../etc"}')
check 400 "$CODE" "18. PUT sub_path 路径穿越 -> 400"

CODE=$(api POST /admin/modules "$ADMIN" '{"module_key":"vksub1","name":"t","gitlab_project_id":"123","sub_path":"../../../../etc"}')
check 400 "$CODE" "18a. POST sub_path 路径穿越 -> 400 (复现 MyModule 的 B4 风险)"
[ -n "$NEWID" ] && api DELETE "/admin/modules/$NEWID" "$ADMIN" >/dev/null

# ---------- B2 /ai-tasks ----------
echo
echo '---------- B2  GET /admin/ai-tasks 可观测性端点 ----------'
CODE=$(api GET "/admin/ai-tasks" "$CSM")
check 403 "$CODE" "19a. 非 ADMIN 访问 -> 403"

CODE=$(api GET "/admin/ai-tasks" "$ADMIN")
check 200 "$CODE" "19. 列表(ADMIN) -> 200"
show
ENV_OK=$(node -e "const d=require('$BODY');console.log(d.code===0 && d.data && Array.isArray(d.data.items) && typeof d.data.total==='number' ?'ok':'bad')")
check "ok" "$ENV_OK" "20. Envelope {code,data:{items,total}} 结构"

CODE=$(api GET "/admin/ai-tasks?requirement_id=$RID&limit=5" "$ADMIN")
check 200 "$CODE" "21. requirement_id 过滤 + 分页 -> 200"
FILTER_OK=$(node -e "const d=require('$BODY').data||{};console.log((d.items||[]).every(x=>x.requirement_id===$RID)?'ok':'bad')")
check "ok" "$FILTER_OK" "22. 过滤结果均属于该需求"

echo
echo '=============================================================='
echo " 结果: PASS=$PASS  FAIL=$FAIL"
echo '=============================================================='
[ "$FAIL" -eq 0 ] || exit 1
