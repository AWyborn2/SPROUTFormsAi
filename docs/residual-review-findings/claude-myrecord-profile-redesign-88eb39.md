# Residual Review Findings

Branch: `claude/myrecord-profile-redesign-88eb39`
Review run: `20260824-155114-d2ed1783`
Date: 2026-08-24

## Residual Review Findings

- **P2** `apps/web/src/screens/enterprise/ProfileScreen.tsx:483` — CompetencyRegister PDF button is inert for non-admin roles. The per-row PDF download button renders as a styled interactive button for all roles but only fires `window.open` for admins. Other roles get a clickable button that silently does nothing — inconsistent with the hero card's download button which shows a toast for non-admins. **Suggested fix:** either hide the PDF button for non-admin roles, or add a toast explaining "Export is available to administrators" (matching the hero card pattern). Severity: P2 | Confidence: 75 | Reviewers: correctness, adversarial, agent-native | Autofix: manual | Defer reason: design choice required (hide vs toast)
