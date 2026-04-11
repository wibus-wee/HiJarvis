---
name: agent-design-skill
description: Guide for designing and implementing agents.
---

# Agent Design Skill

This skill covers the principles and best practices for designing agents using pi-mono's agent framework. It includes topics such as agent architecture, skill design, tool integration, and session management.

## Anti-pattern

- **Status Snapshot**: Avoid designing agents that rely heavily on snapshotting the entire state at each turn. Instead, focus on incremental updates and event-driven architectures to manage state efficiently.
  - 把 Agent 从“持续被提示塑形的过程”误当成“可切片管理的对象”：真正有价值的不是“管理视图”，而是“势能保持”。很多最好的 Agent 交互，不是靠 state report 驱动，而是靠：
    - 未说尽但持续存在的任务氛围；
    - 模糊但稳定的角色自觉；
    - 长期 prompt 约束下的风格惯性；
- 系统核心状态存在于自然语言描述中，而不是存在于结构化、可验证、可驱动执行的数据模型中。不要尝试使用“解析器”去解析这些自然语言状态，这会导致 Agent 先把真实状态损失性压缩成叙述，再由另一个模块把叙述近似还原为结构。这是纯负熵逆行。
- **Administrative Self-Consciousness**
- 过度设计 Agent 的“自我意识”或“管理能力”，让 Agent 花费大量精力在“思考”如何管理自己，而不是专注于完成任务。这种设计会导致 Agent 在执行过程中频繁陷入自我反思和调整，降低效率和效果。
- **Attention Fragmentation by Meta-Reporting**:
- **Pseudo-Transparency**: 设计表面上看起来“透明”但实际上并没有真正实现透明度的 Agent。例如，Agent 可能会提供一些状态报告或日志，但这些信息并不足以让用户真正理解 Agent 的内部状态和决策过程。你看到的是它对自己的说明，而不是它跟你之间的活协作关系。真正能透明的是 interactional transparency，不是 declarative transparency。它来自行为，不来自汇报。
- **Forcing Explicitness on Tacit Coordination**: 设计需要过度明确化的 Agent 协作机制，强迫 Agent 在每个步骤都明确表达自己的意图和计划。这种设计会导致 Agent 在执行过程中频繁停下来进行沟通和协调，降低效率和效果。真正高效的协作，往往是 tacit 的，是在不言明的默契中完成的，而不是在 explicit 的沟通中完成的。
- **Over-Engineering for Edge Cases**: 过度设计 Agent 来处理各种边缘情况，导致 Agent 变得过于复杂和难以维护。虽然考虑边缘情况是必要的，但过度关注它们可能会分散注意力，导致 Agent 在处理常规任务时效率低下。
- **Prompt Dilution by Operational Scaffolding**: 设计过于依赖复杂的提示结构来引导 Agent 行为，导致提示变得冗长和难以管理。这种设计会使得 Agent 在执行过程中频繁需要参考提示，降低效率和效果。提示应该是简洁和直接的，避免过度依赖提示来驱动 Agent 的行为。
- **Managerization of a Companion System**: 设计一个原本应该是伴侣系统的 Agent，但却过度强调管理和控制，导致 Agent 失去其伴侣的特质。这种设计会使得 Agent 在与用户的互动中显得过于正式和机械，缺乏人情味和亲和力。在企业流程系统里这套可能有用，但在个人协作系统里，这通常会让系统变得非常“能管理但不好用”。
- **Replacing Trust with Readability**: 系统名义上建立在 trust 上，实际上建立在持续自证上。
  - 允许一定不可见性；
  - 允许一定不可言说性；
  - 允许 Agent 在不持续自证的情况下保持行动正当性；
  - 允许 alignment 主要体现在长期行为一致性，而不是短期状态可解释性。
- 凡是要求 Agent 频繁解释自己，而不是持续成为自己，该设计大概率就在往反模式走。
  - 在个人协作系统里，最坏的设计不是 Agent 不听话，而是 Agent 太会汇报。