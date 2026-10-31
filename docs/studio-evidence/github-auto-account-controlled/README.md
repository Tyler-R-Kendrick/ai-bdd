# Automatic GitHub accounts: controlled browser evidence

These captures use the actual Studio UI and authentication code with an independently implemented, owned local OAuth code/PKCE provider. The controlled managed principal supplies no email claim. Starting with zero users, the real Studio callback creates one passwordless internal user and session, then opens the workspace. There is no local signup or invitation step.

Captured source: `5bb8d6bb90d2b0fe790b195b1d20af77fae32f45`, tree `e5795487420fff34de5f6138b684f1ae49a1bbf3`. The [published hotfix source](https://github.com/Tyler-R-Kendrick/ai-bdd/commit/869c18bfdce4cb63074deaddafa23e5196f8f870) has that identical tree. HEAD and the recorded product/build inputs stayed unchanged during capture. [verification.json](verification.json) records image and input hashes.

- [Desktop sign-in](controlled-login-desktop.png), 1600 × 1000: one Continue with GitHub action; no Studio email, password, separate signup or invitation form.
- [Mobile sign-in](controlled-login-mobile.png), 390 × 844: the same normal action fits the viewport.
- [Workspace](controlled-workspace-desktop.png), 1600 × 1000: the actual empty workspace after the controlled OAuth callback and automatic user creation. The account area was masked at capture; this image does not demonstrate Member ID sharing.

The capture agent, root reviewer and independent reviewer opened all three images and verified their hashes and captions. The owned session was logged out, and the browser, provider and temporary database were closed. No model calls occurred.

This is controlled local provider evidence. It is not a live Vercel Connect/GitHub callback, production account login, or proof of the rest of the product scope. Production acceptance and actual provider consent remain separate checks.
