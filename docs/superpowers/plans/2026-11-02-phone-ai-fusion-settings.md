# Phone AI and Fusion settings bridge

Approved scope: connect the existing phone settings UI to the existing Mac-owned services, without transferring credentials or running live setup during validation. Reuse ModelAccessService rather than creating another provider configuration; reuse FusionSetup in the signed app rather than launching GUI work from the companion.

1. Add a runtime settings coordinator with sanitized AI metadata, existing revision CAS/checks, and ephemeral Fusion status/request claims. Tests cover secret/reference omission, stale revisions, single claim, timeout and stale completion.
2. Wire actual HTTP and local control routes with existing write authorization, and project runtime data alongside the sparse persistent settings. AI changes are standalone patches so failed CAS cannot partially change other preferences.
3. Have the Mac publish passive installation/running status and claim explicit setup requests before calling existing FusionSetup. Passive refresh must not launch Fusion, an MCP, or read a design. Show last explicit setup results truthfully; bound pending requests and offline status.
4. Verify HTTP/socket JSON with Swift client decoding and mocked Mac callbacks. Run focused and full backend workflows, shared/native builds, independent review and normal PR loop. No provider changes, setup installation, or user document actions during tests.
