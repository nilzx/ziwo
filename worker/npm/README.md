# @ziwo/memory

ziwo (自我, "self") is a memory for an AI: one lasting memory of its own, across the platforms and settings it is used in.

    npx @ziwo/memory@0.3.0-rc.1 deploy --name ziwo-preview

deploys this preview to a separate Worker in your Cloudflare account and, run again later, redeploys the same version. You need a Cloudflare account (the free plan will do to start) and Node.js. Stable releases use `@latest`; opt into a newer preview version deliberately.

What it is, how to connect an AI to it, and everything else: https://github.com/nilzx/ziwo

## Preview channel

This package is the `0.3.0-rc.1` preview. Use the exact version deliberately
on a separate test deployment:

```sh
npx @ziwo/memory@0.3.0-rc.1 deploy --dry-run --name ziwo-preview
npx @ziwo/memory@0.3.0-rc.1 deploy --name ziwo-preview
```

`next` tracks previews; `latest` stays stable. Preview CLI guidance pins its own
version. Before updating real data, save and verify an encrypted backup and
preserve the matching host profile, sessions and connector state. Current
exports can use formats that v0.2.0 cannot import; changing Worker code does not
undo a data migration. Memory backups do not include host binding authority.

Read the [compatibility, migration and rollback guide](https://github.com/nilzx/ziwo/blob/main/docs/preview-release.md)
([中文](https://github.com/nilzx/ziwo/blob/main/docs/preview-release.zh-CN.md)) before opting in.
