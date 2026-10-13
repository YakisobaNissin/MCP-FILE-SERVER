# M2 tools

Inspector: connect to `http://127.0.0.1:3000/mcp`, choose a tool and enter its JSON arguments. Replace `<hash>` with the latest `sha256` from `read_file` or a successful edit. Use a disposable filename that does not already exist.

| Tool         | Example input                                                                                      | Result / restrictions                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| list_files   | `{"path":"projects","recursive":false,"limit":50,"offset":0}`                                      | Metadata and `next_offset`; M1 behavior retained.                                                                         |
| write_file   | `{"path":"projects/m2-check.txt","content":"hello"}`                                               | Created path, size, hash. Parent must exist; no overwrite option.                                                         |
| read_file    | `{"path":"projects/m2-check.txt","start_line":1,"max_lines":200}`                                  | Text, full-file hash, total lines, `has_more`, `next_line/next_column`.                                                   |
| str_replace  | `{"path":"projects/m2-check.txt","old_text":"hello","new_text":"done","expected_sha256":"<hash>"}` | New hash and one replacement; rejects zero or multiple matches, including overlaps.                                       |
| search_files | `{"path":"projects","query":"done","mode":"text","max_results":20}`                                | Paths, matching line numbers/excerpts, skipped count and truncation flags. Use `mode:"name"` for literal filename search. |
| delete_file  | `{"path":"projects/m2-check.txt","confirm":true,"expected_sha256":"<hash>"}`                       | Recovery ID; moves the file into private recovery storage.                                                                |

All schemas reject unknown arguments. Paths are relative and share the protected-path/link policy. File operations support UTF-8 text only, at most 256 KiB, with binary controls and multiple hard links rejected. Input text is at most 16 KiB per field. Outputs include text and structured JSON, capped together at 32 KiB.

Read defaults: line 1, 200 lines; maximum 500 lines and 8 KiB of content per call. Use the returned cursor as `start_line` and `start_column` (zero-based Unicode character offset) to continue even within a long line. Preserve/check the hash across pages.

Search defaults to case-insensitive literal text, with one result per matching line. Bounds: 1000 scanned entries, 8 levels, 100 candidate files, 2 MiB read budget (including rejected binary reads), 100 results and 160-character excerpts. Both search modes skip unsupported files. Narrow the path when truncated; search has no continuation cursor. Listing offsets are best-effort on an unchanged directory.

Failures return MCP `isError:true`. Common codes: `INVALID_INPUT`, `INVALID_PATH`, `PROTECTED_PATH`, `LINK_NOT_ALLOWED`, `HARD_LINK_NOT_ALLOWED`, `NOT_FOUND`, `NOT_FILE`, `BINARY_FILE`, `FILE_TOO_LARGE`, `ALREADY_EXISTS`, `CONFLICT`, `NO_MATCH`, `MULTIPLE_MATCHES`, `UNSAFE_RECOVERY`. Native errors are sanitized.
