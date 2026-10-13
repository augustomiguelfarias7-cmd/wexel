# C# compiler and execution in WebAssembly

## Goal

Add a Wexel language target that can accept C# source, compile it, and execute the resulting program within a controlled WebAssembly environment. This is a design note, not a working compiler implementation.

## Environment check

The development environment used for this change has Node.js 22, Clang/Clang++, and `wasm-ld`, but it does **not** have `dotnet`, `csc`, `mcs`, `mono`, `msbuild`, or `csi` installed. Therefore no C# project can currently be built or executed in this environment, and no C#-to-WebAssembly artifact has been verified.

## Proposed architecture

Keep the compiler/runtime separate from the Wexel Core VFS and Memory64 manager:

1. **C# frontend/compiler:** use Roslyn (`Microsoft.CodeAnalysis.CSharp`) as the language parser, semantic analyzer, and compiler rather than inventing a C# parser from scratch.
2. **WebAssembly-hosted compiler:** build a .NET WebAssembly application containing the compiler components, then verify that its dependencies and file APIs work in the selected browser/Node host.
3. **Program execution:** choose and validate an execution strategy before promising arbitrary C# execution. Roslyn normally emits a managed .NET assembly (CIL/IL), not WebAssembly machine code. A WASM-hosted compiler alone does not make that output executable in WebAssembly.
4. **Managed runtime/interpreter or WASM target:** either execute emitted IL using a compatible managed runtime/interpreter inside WebAssembly, or use a compiler/AOT pipeline that produces a WASM module. Dynamic JIT code generation must not be assumed available in browser WebAssembly.
5. **VFS bridge:** expose source files and references from Wexel's VFS through an explicit host ABI; keep file access and output under Wexel permissions.
6. **Separate adapter:** add a `csharp` language adapter for Wexel Browser and NodeExecution only after both runtime paths have executable integration tests.

## Initial acceptance tests

- Compile a small C# program such as `Console.WriteLine(2 + 40);`.
- Capture stdout, stderr, and exit status.
- Read source files from the Wexel VFS without host-filesystem escape.
- Test missing references, syntax errors, and runtime exceptions.
- Confirm the exact generated output format and how it is executed.
- Verify that the compiler and runtime artifacts can be built reproducibly from pinned toolchain versions.

## Current status

Planning only. The .NET SDK/compiler and a compatible managed execution engine are not installed in the current environment. The Memory64 VFS work does not itself provide C# compilation or execution.
