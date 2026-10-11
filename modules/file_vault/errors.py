"""Coded exceptions shared across the backend. Each carries a machine-readable dot-separated `code`
(e.g. "auth.wrong_password"), translated by the frontend (ui/src/i18n/errors.ts); `params` feeds its templates."""


class VaultError(Exception):
    def __init__(self, code: str, **params):
        self.code = code
        self.params = params
        super().__init__(code)
