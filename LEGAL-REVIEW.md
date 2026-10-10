# Legal review notes: Spectacle

Engineering notes, not legal advice. Last reviewed 10 October 2026. No one can guarantee a project won't be sued; these steps reduce the risk. Cameras and footage of people are a high-risk area, so a lawyer should read the terms before you give the software to anyone outside your own household.

## Where the risk is

| Risk | Status | What to keep doing |
|---|---|---|
| Recording people who didn't agree (wiretap and privacy laws) | Phone mics are never used; IP-camera audio is off and needs a separate confirmation; placement acknowledgement when adding a camera | Never enable audio by default; never record bedrooms, bathrooms or neighbours' property |
| Biometric laws (BIPA and similar) | The app identifies wildlife only, not people | **Do not add face, voice or person recognition.** If ever added, it needs written consent per person, a retention policy and legal review first |
| Children's privacy (COPPA, GDPR-K) | Accounts are for household members; privacy page covers children | Parents manage children's use; don't let the software collect data directly from children without parental involvement |
| Data security and breach duties | scrypt, CSRF, CSP, rate limits, no open internet exposure advice | Keep SECURITY.md accurate; tell affected people if footage leaks; update dependencies (Node, ffmpeg) |
| Footage sharing and defamation | Terms and recording-laws page warn against posting identifiable people | Don't add public sharing features without consent flows |
| Reliance on alerts (it fails to warn about a burglary, fire or injury) | Terms say it is not a professional alarm; limitation of liability | Keep that wording prominent in the app and release notes. It is not a safety device |
| Wrong species ID (poisonous plant, protected species) | Terms and UI say IDs are guesses and start as "review" | Never suggest eating or touching a plant/mushroom based on an ID |
| Open-source licence compliance | THIRD_PARTY_NOTICES.txt; no runtime dependencies | Re-check licence texts from memory-written list before each release; keep Wikipedia/GBIF/Commons attributions visible |
| Android distribution | Sideloaded APK | See below |

## Android developer verification

Google is rolling out developer verification for apps installed on certified Android devices outside Google Play: phase one starts 30 September 2026 in Brazil, Indonesia, Singapore and Thailand, with a global rollout from 2027. A free "limited distribution" account exists for hobbyists sharing with up to 20 devices. A family app fits that. Register the package name and signing key when the programme opens in your region. Source: https://developer.android.com/developer-verification

If you publish on Google Play instead, you also need a Data safety form (camera access, no data shared with third parties), the foreground-service declaration for the "Watching for alerts" service, and a privacy-policy URL.

## Before giving it to non-family users

1. Every user should accept the terms and presence notice (already built in).
2. Have a lawyer review `terms.html`, especially the limitation of liability, which is only enforceable to the extent your jurisdiction allows.
3. Decide whether you will ever offer a hosted version. Hosting other people's camera footage makes you a data processor/controller with much heavier duties (contracts, breach reporting, regional data rules). Keep it self-hosted unless you get advice first.
4. Consider insurance if the software is sold or supported for payment.

## Family-use checklist for the administrator

- [ ] Signs and guest messages (docs/camera-notice-template.md)
- [ ] No cameras in private spaces; privacy masks on neighbours' property
- [ ] Audio off
- [ ] Retention set to what you need (default 14 days)
- [ ] Strong unique passwords; Tailscale only, no port forwarding
