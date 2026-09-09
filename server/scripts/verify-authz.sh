#!/usr/bin/env bash
# P0-01 回归验证：节点操作互斥（SPEC-v1.0.md §10 L222 非负责人 403）。
# 全程真实 HTTP，复现 QA 报告 P0-01 的越权场景 + 正向放行 + 边界状态码。
#
# 用法：
#   cd server
#   SOP_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") node src/index.js &
#   bash scripts/verify-authz.sh
#
# 退出码：0 全部通过；1 存在断言失败。

set -uo pipefail
BASE="${BASE:-http://localhost:4000/api/v1}"
BODY=/tmp/sop_verify_body.json
PASS=0; FAIL=0

j() { node -e "const d=require('$BODY');const p='$1'.split('.');let v=d;for(const k of p){v=v==null?v:v[k]}console.log(v===undefined?'':(typeof v==='object'?JSON.stringify(v):v))" 2>/dev/null; }

api() { # method path token [json-body]
  local m="$1" p="$2" t="$3" b="${4:-}"
  if [ -n "$b" ]; then
    curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H 'content-type: application/json' -H "x-token: $t" -d "$b"
  else
    curl -s -o "$BODY" -w '%{http_code}' -X "$m" "$BASE$p" -H "x-token: $t"
  fi
}

check() { # expected actual label
  if [ "$1" = "$2" ]; then
    PASS=$((PASS+1)); printf 'PASS  %-58s HTTP %s\n' "$3" "$2"
  else
    FAIL=$((FAIL+1)); printf 'FAIL  %-58s HTTP %s (expect %s) body=%s\n' "$3" "$2" "$1" "$(head -c 200 "$BODY")"
  fi
}
show() { printf '      -> %s\n' "$(head -c 220 "$BODY")"; }

login() { # username password -> token
  curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).token;if(!t){console.error('login failed: '+s);process.exit(1)}console.log(t)})"
}

echo "=============================================================="
echo " P0-01 节点操作越权 回归验证  ($BASE)"
echo "=============================================================="

T_ADMIN=$(login admin admin123)   || exit 1
T_CSM=$(login csm01 123456)       || exit 1
T_PO=$(login po01 123456)         || exit 1
T_RD=$(login rd01 123456)         || exit 1
T_QA=$(login qa01 123456)         || exit 1
echo "登录成功: admin / csm01 / po01 / rd01 / qa01"
echo

# ---------- 用例集 A：标准模板全链路 ----------
echo "--- A. 建单（csm01 提单，po01/rd01/qa01 为各节点负责人） ---"
api POST /requirements "$T_CSM" '{"title":"越权回归验证单","description":"用于验证节点操作互斥的后端强制校验，覆盖 submit/confirm/return/force-submit/cancel 五个动作。","po_id":3}' >/dev/null
RID=$(j id); REQNO=$(j req_no)
echo "      需求 RID=$RID ($REQNO) 已创建，status=DRAFT"
# P0 改造：CSM 建单只选产品；研发/测试由产品经 /assign 指派（新接口），保持后续节点鉴权用例不变
check 200 "$(api POST /requirements/$RID/assign "$T_PO" '{"rd_id":4,"qa_id":5}')" "po01  assign 研发/测试到自己的产品需求"
echo

echo "--- B. submit：仅提单人/ADMIN ---"
check 403 "$(api POST /requirements/$RID/submit "$T_QA")"  "qa01  submit 他人需求"; show
check 200 "$(api POST /requirements/$RID/submit "$T_CSM")" "csm01 submit 自己需求"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      current_seq=$(j current_seq) status=$(j status) 节点=$(j nodes.0.name)"
echo

echo "--- C. 当前节点=seq1 HUMAN(CSM 提交需求)，负责人 csm01 ---"
check 403 "$(api POST /requirements/$RID/confirm "$T_QA" '{"note":"x"}')" "qa01  confirm CSM 节点"; show
check 403 "$(api POST /requirements/$RID/confirm "$T_PO" '{"note":"x"}')" "po01  confirm CSM 节点"
check 200 "$(api POST /requirements/$RID/confirm "$T_CSM" '{"note":"提交评审"}')" "csm01 confirm 自己的 CSM 节点"
api GET /requirements/$RID "$T_CSM" >/dev/null; SEQ=$(j current_seq)
echo "      AI 评审节点已自动执行，current_seq=$SEQ (期望 3=产品评审需求)"
echo

echo "--- D. QA 报告 P0-01 原始复现：非负责人对 seq3 PO 节点动作 ---"
check 403 "$(api POST /requirements/$RID/confirm "$T_QA" '{"note":"越权推进"}')"  "qa01  confirm PO 节点 (QA 实测原为 200)"; show
check 403 "$(api POST /requirements/$RID/return  "$T_QA" '{"reason":"越权打回"}')" "qa01  return  PO 节点 (QA 实测原为 200)"; show
check 403 "$(api POST /requirements/$RID/cancel  "$T_QA" '{"reason":"越权取消"}')" "qa01  cancel  他人需求 (QA 实测原为 200)"; show
check 403 "$(api POST /requirements/$RID/confirm "$T_RD" '{"note":"x"}')"          "rd01  confirm PO 节点"
check 403 "$(api POST /requirements/$RID/cancel  "$T_PO" '{"reason":"x"}')"        "po01  cancel  他人需求(非提单人)"
api GET /requirements/$RID "$T_CSM" >/dev/null
echo "      越权尝试后 current_seq=$(j current_seq) status=$(j status)（应与 D 之前一致，未被篡改）"
echo

echo "--- E. 正向放行：节点负责人 / ADMIN ---"
check 200 "$(api POST /requirements/$RID/return "$T_PO" '{"reason":"信息不足，退回重评"}')" "po01  return 自己的 PO 节点"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      打回后 current_seq=$(j current_seq)（AI 节点挂起）"
check 403 "$(api POST /requirements/$RID/confirm "$T_QA" '{}')"  "qa01  confirm 挂起的 AI 节点"; show
check 403 "$(api POST /requirements/$RID/confirm "$T_PO" '{}')"  "po01  confirm 挂起的 AI 节点(非提单人)"
check 200 "$(api POST /requirements/$RID/confirm "$T_CSM" '{}')" "csm01 confirm 挂起的 AI 节点(提单人)"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      重跑 AI 后 current_seq=$(j current_seq)"
check 200 "$(api POST /requirements/$RID/confirm "$T_ADMIN" '{"note":"管理员代确认"}')" "admin confirm PO 节点(管理员豁免)"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      current_seq=$(j current_seq) (期望 5=研发开发)"
check 403 "$(api POST /requirements/$RID/confirm "$T_QA" '{}')"  "qa01  confirm RD 节点"
check 200 "$(api POST /requirements/$RID/confirm "$T_RD" '{}')"  "rd01  confirm 自己的 RD 节点"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      current_seq=$(j current_seq) (期望 7=测试验证上线)"
check 200 "$(api POST /requirements/$RID/confirm "$T_QA" '{}')"  "qa01  confirm 自己的 QA 节点"
api GET /requirements/$RID "$T_CSM" >/dev/null; echo "      current_seq=$(j current_seq) status=$(j status) (期望 DONE)"
echo

echo "--- F. 终态与不存在资源：400 / 404，不得 500 ---"
check 400 "$(api POST /requirements/$RID/confirm "$T_ADMIN" '{}')"    "admin confirm 已 DONE 的需求"; show
check 400 "$(api POST /requirements/$RID/cancel  "$T_CSM" '{}')"      "csm01 cancel  已 DONE 的需求"
check 404 "$(api POST /requirements/999999/confirm "$T_ADMIN" '{}')"  "admin confirm 不存在的需求"; show
check 404 "$(api POST /requirements/999999/cancel  "$T_CSM" '{}')"    "csm01 cancel  不存在的需求(此前静默 200)"
echo

# ---------- 用例集 B：cancel 与重复 submit ----------
echo "--- G. cancel 所有权 + 重复 submit 保护 ---"
api POST /requirements "$T_CSM" '{"title":"取消权限验证单","description":"验证取消操作仅提单人与管理员可执行，且不可重复提交。","po_id":3,"rd_id":4,"qa_id":5}' >/dev/null
RID2=$(j id)
check 403 "$(api POST /requirements/$RID2/cancel "$T_QA" '{"reason":"x"}')" "qa01  cancel DRAFT 态他人需求"
check 200 "$(api POST /requirements/$RID2/submit "$T_CSM")"                 "csm01 submit"
check 400 "$(api POST /requirements/$RID2/submit "$T_CSM")"                 "csm01 重复 submit(此前会把流程打回首节点)"; show
check 200 "$(api POST /requirements/$RID2/cancel "$T_CSM" '{"reason":"验证完成"}')" "csm01 cancel 自己的需求"
api GET /requirements/$RID2 "$T_CSM" >/dev/null; echo "      status=$(j status)"
check 400 "$(api POST /requirements/$RID2/return "$T_CSM" '{"reason":"x"}')" "csm01 return 已 CANCELLED 的需求"
echo

# ---------- 用例集 C：澄清应答鉴权 ----------
echo "--- H. /clarifies/:id/answer 应答人 = 提单人 + ADMIN ---"
api POST /admin/sop-templates "$T_ADMIN" '{"name":"authz-verify-precheck"}' >/dev/null
TPL=$(j id)
api PUT /admin/sop-templates/$TPL/nodes "$T_ADMIN" '{"nodes":[{"node_type":"HUMAN","name":"CSM 提交","role":"CSM"},{"node_type":"AI","name":"AI 预检","ai_action":"PRECHECK"},{"node_type":"HUMAN","name":"产品评审","role":"PO"}]}' >/dev/null
api POST /requirements "$T_CSM" "{\"title\":\"澄清鉴权验证单\",\"description\":\"很短\",\"po_id\":3,\"rd_id\":4,\"qa_id\":5,\"template_id\":$TPL}" >/dev/null
RID3=$(j id)
api POST /requirements/$RID3/submit "$T_CSM" >/dev/null
api POST /requirements/$RID3/confirm "$T_CSM" '{}' >/dev/null
api GET /requirements/$RID3 "$T_CSM" >/dev/null
CID=$(j open_clarifies.0.id); echo "      status=$(j status) 待澄清问题 id=$CID"
check 403 "$(api POST /clarifies/$CID/answer "$T_QA" '{"answer":"越权回答"}')" "qa01  回答他人需求的澄清"; show
check 403 "$(api POST /clarifies/$CID/answer "$T_PO" '{"answer":"越权回答"}')" "po01  回答他人需求的澄清"
check 403 "$(api POST /requirements/$RID3/force-submit "$T_QA" '{}')"          "qa01  force-submit 他人需求"
check 200 "$(api POST /clarifies/$CID/answer "$T_CSM" '{"answer":"目标用户为客户侧运营。"}')" "csm01 回答自己需求的澄清"
check 400 "$(api POST /clarifies/$CID/answer "$T_CSM" '{"answer":"重复回答"}')" "csm01 重复回答同一澄清(此前会重复追加正文并重跑 AI)"; show
check 404 "$(api POST /clarifies/999999/answer "$T_CSM" '{"answer":"x"}')"      "csm01 回答不存在的澄清"
api POST /requirements/$RID3/cancel "$T_CSM" '{"reason":"验证完成"}' >/dev/null
echo

echo "=============================================================="
printf ' 结果: PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ] || exit 1
