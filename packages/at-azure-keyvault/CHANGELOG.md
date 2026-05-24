# Changelog — at-azure-keyvault

## 0.2.0-pre.1

### Minor Changes

- First release. Azure Key Vault `SealingKeyProvider` — RSA-OAEP-256 encrypt/decrypt. RSA decrypt is version-bound: pin a versioned keyId (auto-rotation on a versionless key orphans sealed vaults) ([#190](https://github.com/vLannaAi/noy-db/issues/190)).

