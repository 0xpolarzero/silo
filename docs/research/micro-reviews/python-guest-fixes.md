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

## UTF-8-decodable binaries are rewritten as launchers

`launcher_contents` treated every UTF-8-decodable file beneath `bin` as text.
A valid WebAssembly module with a custom section containing `/root/tool`
was rewritten to `/home/silo/tool` without updating its section length, corrupting
the copied module. The source remained intact, but retry retained the bad copy.

The [WebAssembly binary format](https://webassembly.github.io/spec/core/binary/modules.html#binary-customsec)
defines the module header and length-delimited custom sections used by the
fixture. Skip text relocation for files containing NUL bytes. The regression
checks exact binary bytes and retry behavior using the real `copy_home` function;
existing launcher relocation tests continue to exercise text scripts. The
focused suite passed 19 tests on Python 3.12. A disposable Node
`WebAssembly.validate` check accepted the original fixture and rejected its
path-expanded bytes.

## Manifest line comments produce false command errors

`check-command-manifest.py` extracted quoted names from line comments in
`build.rs`, while its handler parser already ignored line comments. A valid
manifest containing an inline comment naming `"reveal"` and a disabled
`// "retired",` entry produced false duplicate and unregistered-command errors.

The [Rust reference](https://doc.rust-lang.org/reference/comments.html#non-doc-comments)
treats ordinary comments as whitespace. Apply the existing line-comment
handling to the manifest body. The fixture regression failed with both false
errors before the fix; real repository sources remain covered by the existing
test. This changes an internal CI checker, so no app changeset is needed.

## Build wrappers mistake arbitrary JSON output for Cargo messages

`release-dependency-cache.py` and `dependency-cache-benchmark.py` parsed all
valid JSON stdout lines as Cargo message dictionaries. A temporary executable
printing `null` before a compiler artifact made both real build functions raise
`AttributeError`, before waiting for the process or preserving its exit status.

The [Cargo JSON message contract](https://doc.rust-lang.org/cargo/reference/external-tools.html#json-messages)
defines object messages and explicitly permits arbitrary output from other
tools. Treat non-object JSON as ordinary tool output, exclude it from the
artifact inventory, and close the exhausted stdout pipe before waiting. Real
temporary executable regressions cover null, array, string, number, and boolean
output and invalid UTF-8 bytes; release-build success and exit 19; benchmark artifact freshness and
synthetic configuration verification. No Cargo compilation or runtime
preparation runs in these tests. Both focused groups failed before the fix.
An invalid UTF-8 byte also raised `UnicodeDecodeError` before the JSON parser;
decode the stream as UTF-8 with replacement, matching the guest computer-use
command helper's existing treatment of diagnostic output.
The dependency-tool suite passed 33 tests on Python 3.12 with
`ResourceWarning` promoted to an error.

## Build CLI signal statuses wrap into unrelated exit codes

Both dependency build wrappers returned the negative `Popen.wait()` status
directly to `sys.exit`. A child terminating itself with SIGTERM made each CLI
exit 241 instead of 143. The
[Python subprocess contract](https://docs.python.org/3.12/library/subprocess.html#subprocess.Popen.returncode)
defines `-N` as termination by signal N; the shell convention is 128 + N.

Use the same conversion already used by `measure-command.py` and
`retry-bundle.py`. Keep the benchmark report's raw subprocess status intact.
CLI regressions run temporary self-terminating executables, assert exit 143,
and check benchmark `exitCode: -15`. Both failed with actual exit 241 before the
fix. The tests neither identify nor signal an external process.
The dependency-tool group passed 35 tests on Python 3.12 with resource warnings
treated as errors; the release-workflow group passed nine tests. Format,
typecheck, lint, and whitespace checks also passed before each fix commit.

## Checkout source validation assumes input order

The final merged-tree Python run executed 397 tests and found one failure:
`test_all_checkout_jobs_use_validated_source` extracted zero of four checkouts
after credential hardening inserted `persist-credentials: false` before `ref`.
The regular expression required `ref` to be the first input, although input
order does not change a checkout's selected revision.
The [YAML mapping-order contract](https://yaml.org/spec/1.2.2/#3221-mapping-key-order)
makes key order a serialization detail.

Allow preceding inputs within the same indented `with` block. Keep the existing
assertions that every checkout has a ref and that all refs match their validated
source. The regression exercises four release and three platform checkouts;
it failed before the change and passed afterwards. The full run's other 382
executed tests passed and 14 were skipped. All tests use fixtures; no app,
installed bundle, guest VM, or release publication was exercised.
The focused source-validation and release-workflow groups passed five and ten
tests on Python 3.12; Node 24 typecheck/lint and Rust formatting passed.
