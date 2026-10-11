from modules.file_vault.errors import VaultError


def test_vault_error_carries_code_and_params():
    exc = VaultError("auth.wrong_password")
    assert exc.code == "auth.wrong_password"
    assert exc.params == {}
    assert str(exc) == "auth.wrong_password"


def test_vault_error_carries_extra_params():
    exc = VaultError("task.merge_failed", detail="conflict in foo.py")
    assert exc.code == "task.merge_failed"
    assert exc.params == {"detail": "conflict in foo.py"}
