import sys

import pytest

sys.path.append(".")


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """No test may touch the real documents: the API's library (opened
    lazily by any document/search endpoint) lives in a temp dir."""
    import app.api as api
    from app.config.config_files import StorageConfig

    monkeypatch.setattr(StorageConfig, "data_dir", tmp_path / "data")
    yield
    lib = api._library
    if lib is not None and lib.data_dir == tmp_path / "data":
        lib.close()
        api.set_library(None)
