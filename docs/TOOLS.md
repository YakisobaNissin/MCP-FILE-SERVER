# M1 tool: list_files

Lists permitted workspace files and directories with bounded output. Read-only annotations describe the tool to hosts; server-side checks enforce policy independently of those annotations.

| Argument    | Type / default    | Constraint                                                        |
| ----------- | ----------------- | ----------------------------------------------------------------- |
| `path`      | string / `.`      | Relative directory, 1–512 characters. Both slash styles accepted. |
| `recursive` | boolean / `false` | Descend up to 8 entry levels.                                     |
| `limit`     | integer / `50`    | 1–100 returned entries.                                           |
| `offset`    | integer / `0`     | 0–1000 permitted entries to skip.                                 |

Unknown keys, coercible strings in numeric/boolean fields, and null arguments are rejected. Paths must not be absolute, contain parent or dot segments, empty segments, control characters, Windows device names, alternate-data-stream colons, wildcards, or trailing dots/spaces. Root is represented by `.` only.

```json
{ "path": "projects", "recursive": false, "limit": 10, "offset": 0 }
```

Example result (timestamps depend on the actual files):

```json
{
  "path": "projects",
  "entries": [
    {
      "path": "projects/welcome.md",
      "type": "file",
      "size_bytes": 82,
      "modified_at": "2026-10-13T00:00:00.000Z"
    }
  ],
  "returned": 1,
  "truncated": false,
  "next_offset": null,
  "scan_limit_reached": false,
  "depth_limit_reached": false,
  "output_limit_reached": false
}
```

This is an illustrative contract, not captured evidence. Directories report `size_bytes: 0`; directory byte sizes are platform-dependent and not useful here. Modification times are ISO 8601 UTC. All entry paths are relative to the workspace root, including when a narrower directory is requested.

The tool returns matching JSON in a text content block and `structuredContent`. The listing payload is capped at approximately 12 KiB, reserving room to keep the serialized tool result below 32 KiB. Scans examine at most 1000 directory entries total (including protected entries), with at most 8 recursive levels. Inaccessible, linked, protected, invalid, and concurrently removed entries are omitted without returning their names.

Use `next_offset` only with the same `path` and `recursive` values. Offsets are best-effort on an unchanged workspace, not snapshot cursors. When scan/depth limits apply, even a null `next_offset` does **not** mean the entire subtree was examined; choose a narrower path. Scanning a directory with more than 1000 entries sees a bounded subset in OS enumeration order before sorting. Pagination cannot recover entries beyond that budget.

Expected tool errors include `INVALID_PATH`, `PROTECTED_PATH`, `LINK_NOT_ALLOWED`, `OUTSIDE_WORKSPACE`, `NOT_FOUND`, `NOT_DIRECTORY`, `ACCESS_DENIED`, and sanitized `INTERNAL_ERROR`. SDK schema errors also return `isError: true`. The SDK controls protocol-level errors. Raw native errors and stack traces are never deliberately included in application results.
