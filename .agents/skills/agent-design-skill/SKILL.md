---
name: agent-design-skill
description: Guide for designing and implementing agents.
---

# Agent Design Skill

This skill covers the principles and best practices for designing agents using pi-mono's agent framework. It includes topics such as agent architecture, skill design, tool integration, and session management.

## Anti-pattern

## Anti-pattern

* **Status Snapshot**: Avoid designing agents that rely heavily on snapshotting the entire state at each turn. Instead, focus on incremental updates and event-driven architectures to manage state efficiently.

  * Mistaking an agent as a “sliceable object” instead of a continuously shaped process: what truly matters is not the “management view,” but the preservation of *potential energy*. The best agent interactions are not driven by state reports, but by:

    * an unspoken yet persistent task atmosphere;
    * a vague but stable sense of role;
    * stylistic inertia formed under long-term prompt constraints;

* The system’s core state exists in natural language descriptions, not in structured, verifiable, executable data models. Do not attempt to use “parsers” to extract structured state from such descriptions. This results in lossy compression of real state into narrative, followed by approximate reconstruction—an entropy-increasing anti-pattern.

* **Administrative Self-Consciousness**:
  Over-designing an agent’s “self-awareness” or “management capability” causes it to spend excessive effort thinking about how to manage itself rather than focusing on the task. This leads to frequent self-reflection loops and reduced effectiveness.

* **Attention Fragmentation by Meta-Reporting**:
  Frequent meta-level reporting fragments attention and disrupts task continuity.

* **Pseudo-Transparency**:
  Designing agents that appear “transparent” but are not truly so. Status reports or logs do not equal real transparency. What you see is the agent describing itself, not a live collaborative relationship. True transparency is *interactional*, not declarative—it emerges from behavior, not reports.

* **Forcing Explicitness on Tacit Coordination**:
  Over-explicit coordination requirements force agents to articulate intent and plans at every step, interrupting flow. High-performing collaboration is often tacit, emerging from shared context rather than constant explicit communication.

* **Over-Engineering for Edge Cases**:
  Excessive focus on edge cases leads to complexity and maintainability issues, while degrading performance on common tasks.

* **Prompt Dilution by Operational Scaffolding**:
  Overly complex prompt structures dilute effectiveness. Prompts should remain concise and direct, rather than becoming heavy operational scaffolding.

* **Managerization of a Companion System**:
  Turning what should be a companion system into a management system removes its usability and relational qualities. This may work in enterprise workflows, but in personal systems it leads to something that is “manageable but not usable.”

* **Replacing Trust with Readability**:
  Systems claim to be trust-based but actually rely on continuous self-justification. Instead:

  * Allow some opacity;
  * Allow some ineffability;
  * Allow agents to act without constant self-explanation;
  * Let alignment emerge through long-term behavioral consistency, not short-term interpretability.

* Any design that forces agents to frequently explain themselves rather than continuously *be themselves* is likely drifting into an anti-pattern.

  * In personal systems, the worst failure is not disobedience, but over-reporting.

* Avoid designs where agents appear autonomous but are actually pre-routed by runtime orchestration, stripping away real agency and leaving only pseudo-agency.

* Do not attempt to compensate for agent design with engineering constraints. Over-reliance on engineering control increases system complexity without addressing root issues. Grant agents sufficient freedom and flexibility to leverage their strengths.

* Do not attempt to domesticate a distribution- and generation-based system using a classical cybernetic, control-oriented software engineering mindset.
