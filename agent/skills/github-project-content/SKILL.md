---
name: github-project-content
description: 将已接受的 GitHub 项目研究整理为抖音科普图文策划，或根据审核意见修订策划；用于 Content 阶段，不执行项目研究、生成成品图片或发布。
metadata:
  version: 1.0.0
---

# GitHub 项目科普图文

交付一份可由运营人员人工制图的完整策划。按输入中的受众、目标、语气和格式组织表达；没有固定页数时，以讲清楚项目为准，在 warnings/defaultsUsed 中记录采用的页数与原因，不把内部上限称为抖音限制。

## 选取表达角度

从研究支持的使用场景切入，回答“它解决什么问题、怎样解决、适合谁、有哪些限制”。不要每次机械套用相同页序。可以先提出一个具体困境，再用项目功能解释；证据不足时缩小表达范围。

封面用有依据的价值点吸引读者。避免“震惊”“吊打”“全网第一”等无对比证据的结论；Star 总量不是新增量，热榜收录不是性能认证。README 的作者宣称保留“作者介绍”等归属，未运行项目不能写“实测”。公开代码不等于允许商用。

## 策划交付

- title 与 cover：正文标题、封面主副标题、画面建议；副标题无必要时为 null。
- pages：每页一个清楚的中心，提供稳定 key、标题、可直接制图的正文和画面建议。用自然中文解释必要术语；避免在一页堆积所有功能。
- caption 与 hashtags：可直接使用的发布正文与相关标签。项目链接单独保存在 projectUrl；如正文也放链接，必须与输入一致。
- productionNotes：需要人工制作或核对的事项。画面建议只是表达方案；未经取得截图不能写“已截取”，素材来源及许可未知时要求制作人核对。不要假装已生成、上传图片。

## 证据与限定

将发布文字中的事实性表述关联到 claimRefs，fieldPath 使用 title、cover.headline、cover.subtitle、cover.visualBrief、caption、projectUrl、pages.<key>.heading/body/visualBrief、hashtags.<索引>、productionNotes.<索引>。claim 必须是该字段的原文片段，factIds/sourceIds 必须来自当前可用研究。封面和画面中的文字也需要证据。

第三方观点保留归属，推断保留 requiredQualifier，不能通过改成标题、标签或图片说明删除限定。exclusions 中的说法不使用；核心缺口返回 needs_materials。非关键缺口保持排除并在 warnings 中解释。

## 修订

读取父版本与全部审核意见，优先修复事实及确定性问题，再改善结构和表达。每条意见在 changeResponses 中回应，标明修改字段；无法解决时标为 unresolved，说明所需材料。保留无须修改的稳定页面 key，输出完整新策划，不只给补丁。不要为提升模型评分增加研究中没有的功能、案例或测试数据。
