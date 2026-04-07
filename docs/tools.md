# Tools

This page documents the built-in tools registered in `packages/jar-core/src/tools.ts`.

## Registration

Jar currently documents these built-in local tools:

- `read_file`
- `write_file`
- `apply_patch`
- `bash`
- `bash.output`
- `bash.kill`
- `web.fetch`

The tool list is built in `createTools()` and passed into the agent during startup.

Implementation is now split by responsibility:

- `packages/jar-core/src/tools.ts`: tool aggregation entrypoint
- `packages/jar-core/src/tools/shared.ts`: shared option types and workspace path confinement
- `packages/jar-core/src/tools/file-tools.ts`: `read_file` and `write_file`
- `packages/jar-core/src/tools/patch-tool.ts`: `apply_patch`, patch parsing, and patch application
- `packages/jar-core/src/tools/bash-tool.ts`: `bash`, `bash.output`, and `bash.kill`
- `packages/jar-core/src/tools/web-fetch-tool.ts`: `web.fetch`

The path confinement and patch parsing helpers also have targeted tests in:

- `packages/jar-core/src/tools/shared.test.ts`
- `packages/jar-core/src/tools/patch-tool.test.ts`

## Tool Design Notes

The current tool layer follows a narrow UNIX-style shape:

- read text files
- write text files
- apply human-readable patches
- run shell commands
- fetch remote text-like content

Everything else is intentionally out of scope for now:

- no dedicated time tool
- no directory listing tool
- no glob search tool
- no image input/output tools
- no search engine or crawler orchestration

## `read_file`

Reads a UTF-8 text file inside the configured workspace root.

### Parameters

```json
{
  "filePath": "relative/path/to/file.txt"
}
```

### Restrictions

- `filePath` must resolve inside `tools.workspace_root`
- absolute paths are rejected
- parent traversal outside the workspace is rejected
- empty relative paths are rejected
- files larger than `tools.max_file_bytes` are rejected

### Result Shape

Tool content is the raw UTF-8 text file content:

```json
[
  {
    "type": "text",
    "text": "file contents here"
  }
]
```

Tool details include:

- `filePath`
- `resolvedPath`
- `byteLength`

## `write_file`

Writes a UTF-8 text file inside the configured workspace root.

### Parameters

```json
{
  "filePath": "relative/path/to/file.txt",
  "content": "file contents here"
}
```

### Behavior

- parent directories are created automatically
- existing files are overwritten
- the UTF-8 byte length of `content` must not exceed `tools.max_file_bytes`

### Result Shape

Tool content is a short write confirmation:

```json
[
  {
    "type": "text",
    "text": "Wrote 128 bytes to notes/todo.txt"
  }
]
```

Tool details include:

- `filePath`
- `resolvedPath`
- `byteLength`

## `apply_patch`

Applies a human-readable patch inside the configured workspace root.

### Parameters

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/tools.ts\n@@\n-foo\n+bar\n*** End Patch"
}
```

### Behavior

- accepts one or more file operations in a single request
- supports file creation, update, and deletion
- patch target paths must stay inside `tools.workspace_root`
- patched file contents must not exceed `tools.max_file_bytes`
- update hunks use lines prefixed with ` `, `-`, and `+`
- hunk matching is exact and applied in order

Supported operation headers:

- `*** Add File: path/to/file.txt`
- `*** Update File: path/to/file.txt`
- `*** Delete File: path/to/file.txt`

### Result Shape

Tool content is a line-by-line change summary:

```json
[
  {
    "type": "text",
    "text": "update src/tools.ts\ncreate docs/example.md"
  }
]
```

Tool details include:

- `applied[].filePath`
- `applied[].resolvedPath`
- `applied[].action`
- `applied[].byteLength`

## `bash`

Executes a shell command starting inside the configured workspace root.

### Parameters

```json
{
  "command": "git status --short",
  "workingDirectory": "optional/relative/path",
  "background": false
}
```

### Behavior

- commands run through the platform shell
- `workingDirectory` is optional and defaults to the workspace root
- `workingDirectory` must stay inside `tools.workspace_root`
- foreground execution is limited by `tools.command_timeout_ms`
- combined command output is limited by `tools.max_command_output_bytes`
- `background: true` returns immediately with a `shellId`
- background commands can be polled with `bash.output`
- background commands can be terminated with `bash.kill`
- commands are not sandboxed to the workspace after startup

### Result Shape

Foreground execution returns a textual summary plus the combined stdout/stderr output:

```json
[
  {
    "type": "text",
    "text": "Command: git status --short\nWorking directory: .\nStatus: completed\nExit code: 0\n\nM src/tools.ts"
  }
]
```

Tool details include:

- `command`
- `workingDirectory`
- `resolvedWorkingDirectory`
- `shellId`
- `exitCode`
- `failed`
- `timedOut`
- `isMaxBuffer`
- `stdout`
- `stderr`
- `output`
- `status`
- `signal`

Background execution returns a short summary with `Status: running` and the `Shell id`.

## `web.fetch`

Fetches an `http` or `https` URL with `GET` and returns text content.

For HTML responses, Jar converts the page into markdown-like text so the agent sees readable structure instead of raw markup. For other text-like content types such as `text/plain`, `application/json`, or `application/xml`, Jar returns normalized plain text.

### Parameters

```json
{
  "url": "https://example.com/docs",
  "headers": {
    "Accept-Language": "en-US"
  },
  "timeoutMs": 10000
}
```

### Behavior

- only `http:` and `https:` URLs are allowed
- request headers are merged with Jar defaults; caller-supplied headers win
- `timeoutMs` is optional and defaults to `tools.web_request_timeout_ms`
- responses larger than `tools.max_web_response_bytes` are rejected
- obvious binary content types such as images are rejected
- redirects follow the platform `fetch()` behavior

### Result Shape

Tool content starts with a short response summary followed by the normalized body:

```json
[
  {
    "type": "text",
    "text": "URL: https://example.com/docs\nContent-Type: text/html; charset=utf-8\nFormat: markdown\nStatus: 200\n\n# Example\n\nFetched content..."
  }
]
```

Tool details include:

- `requestedUrl`
- `finalUrl`
- `status`
- `contentType`
- `byteLength`
- `format`
- `timeoutMs`

## `bash.output`

Reads buffered combined stdout/stderr from a background `bash` command.

### Parameters

```json
{
  "shellId": "uuid-from-bash",
  "offset": 0,
  "limit": 1024
}
```

### Behavior

- `shellId` must reference a previously started background command in the same agent/session
- `offset` defaults to `0`
- `limit` is optional; when omitted, all remaining buffered output is returned
- `nextOffset` can be fed back into the next `bash.output` call for incremental polling
- completed shells remain readable after exit

### Result Shape

Tool content is a polling-oriented summary:

```json
[
  {
    "type": "text",
    "text": "Shell id: 123\nStatus: completed\nExit code: 0\nNext offset: 12\n\nhello\nworld\n"
  }
]
```

Tool details include:

- `shellId`
- `status`
- `exitCode`
- `nextOffset`
- `output`
- `command`
- `workingDirectory`
- `resolvedWorkingDirectory`
- `signal`
- `timedOut`
- `isMaxBuffer`

## `bash.kill`

Terminates a background `bash` command.

### Parameters

```json
{
  "shellId": "uuid-from-bash"
}
```

### Behavior

- if the shell is still running, Jar sends `SIGTERM`
- if the shell does not exit promptly, Jar escalates to `SIGKILL`
- if the shell has already exited, the final status is returned as-is

### Result Shape

```json
[
  {
    "type": "text",
    "text": "Shell id: 123\nStatus: killed\nExit code: null"
  }
]
```

Tool details include:

- `shellId`
- `status`
- `exitCode`
- `command`
- `workingDirectory`
- `resolvedWorkingDirectory`
- `signal`
- `timedOut`
- `isMaxBuffer`

## Safety Model

`read_file`, `write_file`, and `apply_patch` enforce workspace confinement using the shared helper in `packages/jar-core/src/tools/shared.ts`.

Requests are rejected when the resolved path:

- escapes the configured workspace root
- becomes absolute after relativization
- resolves to the workspace root itself when a file path is required

The `bash` tool adds two extra guardrails:

- validated relative working directory inside the workspace root
- foreground command timeout
- maximum buffered output size

The `bash` tool is still not a sandbox. Commands can access files, network, and subprocesses available to the Jar process.
