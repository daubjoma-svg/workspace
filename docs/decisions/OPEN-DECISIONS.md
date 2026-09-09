# OPEN DECISIONS — 悬而未决登记册

> 规则：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution）。每次 Phase 开始时复现到工作上下文最前面，逐条判断能否关闭。已关闭项可升格为 ADR。

汇总：**2 未决 / 1 已决**

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-08-05 | Phase 4 / 设计裁决 §9 item9 | 半像素字号收敛到 8 级阶梯（12.5/13.5/11.5/14.5px → 阶梯值） | 阶梯下限 12px；`.flow-sub`/`.flow-st` 现 10.5px、`.flow-name`/`.tbl th`/`.tag` 现 11.5px，需上调 0.5–1.5px | **缓做**。`.flow-step` 仅 76px min-width 且 `.flow-name` 为 2 行钳制，10.5→12px 是 14% 增幅，几乎必然溢出或多折行 | 无浏览器/真机视觉回归环境（playwright 未安装），SSR 只能验 HTML 结构验不了布局溢出 | 具备视觉回归能力后，实测 `.flow-step` 在最长节点名下不溢出 | `design-decision-to-evaluate` **OPEN** |
| 2026-08-05 | Phase 4 / QA advisory | `/modules/{id}/sync` 由同步直返改为异步入队 + `task_id` 轮询 | openapi.yaml 已按异步定义；GitLab 限流 5 req/min/user（ADR-005），同步直返在多模块并发下必然打爆配额 | 倾向做，但不进本期 | 等后端回报工作量（人日）后排期 | 后端给出人日估算，且一期 P0/P1 清零 | `waiting-on-external-condition` **OPEN** |
| 2026-08-05 | Phase 2 / 设计 | `--space-*` / `--text-*` / `--w-*` / `--row-*` 尺寸类 Token 下沉到组件层 | 本轮只接了色彩/形状/动效三类 Token | 缓做，与字号阶梯同批处理更省事 | 同上（视觉回归环境） | 与字号阶梯一并落地 | `design-decision-to-evaluate` **OPEN** |
| 2026-08-05 | Phase 4 / 设计裁决 决策 2 | 需求等级 `.lv-1~4` 的视觉编码方案 | `--info` 与 `--accent` 归并会造成"等级 3"与"选中态"同色语义塌缩；且破坏「每屏 ≤2 处 accent」预算 | — | — | — | **RESOLVED** |

## Resolutions

### 等级视觉编码（2026-08-05 关闭）
**结论**：驳回 `--info: var(--accent)` 归并方案，改用单色序数梯（DESIGN.md §4.9.1）。`--info` 从 Token 表彻底删除且**不留别名**——别名是技术债复活入口。

**理由**：等级是**有序量（ordinal）**，不是分类量（nominal），本就不该用色相编码。改用亮度 + 字重 + 填充实度三条冗余通道，不占色相预算，天然满足 WCAG 1.4.1（不以颜色作为唯一信息载体）。实测对比度 5.43–16.72（浅）/ 5.89–16.22（深），全档达标。

**可升格为 ADR**：是（建议 ADR-009，涉及设计系统的色相预算原则）。
