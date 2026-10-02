# Python guest helper fixes

All reproductions use temporary filesystem fixtures, without an app or VM.

## Non-object LCU receipts block repair

`setup-lcu.py` decoded the receipt and immediately called `.get()`. A receipt
containing `[]`, `null`, a string, a number, or a boolean raised `AttributeError`.
`desktop.rs` runs this status command under `set -eu` before installing the
setup helper, so the failure blocked the setup repair path.

The [Python 3.12 JSON conversion table](https://docs.python.org/3.12/library/json.html#json.JSONDecoder)
confirms that valid JSON need not decode to a dictionary. Validate the decoded
type and return the existing `repair-required` / `invalid-receipt` result.
`test_lcu_setup.py` exercises all five non-object types and checks that passive
status runs no subprocess. The regression failed before the guard and passed
after it; the focused suite passed 11 tests on Python 3.12 and 3.14.

## Non-UTF-8 shell configuration blocks account migration

`working-account.py` copied shell configuration, then decoded it using
`Path.read_text()` to relocate home paths. A Latin-1 byte in a shell comment
raised `UnicodeDecodeError` before account setup completed. Text I/O also
normalized existing line endings. Shell configuration is an existing guest
file, not a Silo UTF-8 document.

The [Python 3.12 pathlib byte I/O contract](https://docs.python.org/3.12/library/pathlib.html#pathlib.Path.read_bytes)
supports reading and writing unchanged bytes. Relocate only the known ASCII
home prefixes and append the existing ASCII PATH setup as bytes. A temporary
two-run migration regression checks Latin-1 comments, CRLF preservation,
home-path relocation, PATH setup, and unchanged originals. It failed with
`UnicodeDecodeError` before the fix. The focused suite passed 18 tests on
Python 3.12, including the inherited atomic-publication regressions.
