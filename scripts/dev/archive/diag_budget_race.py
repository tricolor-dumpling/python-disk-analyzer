"""UI2·U1.1 诊断脚本：复现 test_concurrent_saves_serialize_accounting 的 worker 异常。
只读诊断，不改产品代码；运行后自删由执行者决定。"""
import json
import tempfile
import threading
import time
import traceback
from pathlib import Path
from unittest import mock

import snapshots

ROWS = [{"p": "C:\\T", "s": 1000}]

def main():
    tmp = tempfile.TemporaryDirectory()
    dir_path = Path(tmp.name)
    errors = []
    ok = []
    with mock.patch.object(snapshots, "MAX_BYTES_PER_DAY", 10 * 1024 * 1024):
        threads = []
        for i in range(8):
            def worker(idx=i):
                rows = [{"p": f"C:\\T{idx}", "s": 100 + idx}]
                for attempt in range(100):
                    try:
                        path = snapshots.save_snapshot(
                            f"C:\\T{idx}", rows, dir_path=dir_path,
                            auto=False, machine_guid="deadbeef-1234",
                            fingerprint={"count": idx + 10, "crc32": idx},
                            now=None,
                        )
                        if path is None:
                            errors.append((idx, "RETURNED_NONE", "attempt " + str(attempt)))
                            return
                        ok.append(idx)
                        return
                    except snapshots.SnapshotBusyError:
                        time.sleep(0.01)
                    except Exception as exc:
                        errors.append((idx, type(exc).__name__, traceback.format_exc().splitlines()[-1]))
                        return
                errors.append((idx, "RETRIES_EXHAUSTED", "100 attempts"))
            t = threading.Thread(target=worker)
            threads.append(t)
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
    print("ok:", sorted(ok))
    print("errors:")
    for e in errors:
        print("  ", e)
    lock = dir_path / "_lock"
    print("leftover files:", [p.name for p in dir_path.iterdir()][:20])

if __name__ == "__main__":
    main()
