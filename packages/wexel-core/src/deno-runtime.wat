(module
  ;; ── Imports JS (devem vir primeiro) ──────────────────────────────────────
  (import "__wexel_host" "fs_read"     (func $fs_read     (param i32 i32) (result i32 i32)))
  (import "__wexel_host" "fs_write"    (func $fs_write    (param i32 i32 i32 i32)))
  (import "__wexel_host" "fs_exists"   (func $fs_exists   (param i32 i32) (result i32)))
  (import "__wexel_host" "fs_mkdir"    (func $fs_mkdir    (param i32 i32)))
  (import "__wexel_host" "fs_remove"   (func $fs_remove   (param i32 i32)))
  (import "__wexel_host" "fs_list"     (func $fs_list     (param i32 i32) (result i32 i32)))
  (import "__wexel_host" "fs_cwd"      (func $fs_cwd      (result i32 i32)))
  (import "__wexel_host" "fs_cd"       (func $fs_cd       (param i32 i32)))
  (import "__wexel_host" "env_get"     (func $env_get     (param i32 i32) (result i32 i32)))
  (import "__wexel_host" "stdout_write"(func $stdout_write(param i32 i32)))
  (import "__wexel_host" "stderr_write"(func $stderr_write(param i32 i32)))
  (import "__wexel_host" "proc_exit"   (func $proc_exit   (param i32)))

  ;; ── Memória compartilhada (SharedArrayBuffer) ─────────────────────────────
  ;; Página 0 (0-65535): bloco de controle SAB
  ;;   [0]  i32 lock  0=livre 1=pedido 2=ok 3=erro
  ;;   [4]  i32 size  tamanho do payload
  ;; Página 1+: heap do runtime
  (memory (export "memory") 16 256 shared)

  ;; ── Globals ───────────────────────────────────────────────────────────────
  (global $heap_ptr (mut i32) (i32.const 65536))

  ;; ── Alocador bump ─────────────────────────────────────────────────────────
  (func (export "wexel_alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap_ptr))
    (global.set $heap_ptr
      (i32.and
        (i32.add (i32.add (global.get $heap_ptr) (local.get $size)) (i32.const 7))
        (i32.const -8)))
    (local.get $ptr))

  (func (export "wexel_free") (param i32) (param i32))

  ;; ── ABI version ───────────────────────────────────────────────────────────
  (func (export "wexel_deno_abi_version") (result i32) (i32.const 10000))

  ;; ── Init ──────────────────────────────────────────────────────────────────
  (func (export "wexel_runtime_init")
    (i32.store (i32.const 0) (i32.const 0))
    (i32.store (i32.const 4) (i32.const 0)))

  ;; ── Filesystem ────────────────────────────────────────────────────────────
  (func (export "wexel_fs_read")   (param i32 i32) (result i32 i32) (call $fs_read   (local.get 0) (local.get 1)))
  (func (export "wexel_fs_write")  (param i32 i32 i32 i32)          (call $fs_write  (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  (func (export "wexel_fs_exists") (param i32 i32) (result i32)     (call $fs_exists (local.get 0) (local.get 1)))
  (func (export "wexel_fs_mkdir")  (param i32 i32)                   (call $fs_mkdir  (local.get 0) (local.get 1)))
  (func (export "wexel_fs_remove") (param i32 i32)                   (call $fs_remove (local.get 0) (local.get 1)))
  (func (export "wexel_fs_list")   (param i32 i32) (result i32 i32) (call $fs_list   (local.get 0) (local.get 1)))
  (func (export "wexel_fs_cwd")    (result i32 i32)                  (call $fs_cwd))
  (func (export "wexel_fs_cd")     (param i32 i32)                   (call $fs_cd     (local.get 0) (local.get 1)))

  ;; ── Processo ──────────────────────────────────────────────────────────────
  (func (export "wexel_env_get")      (param i32 i32) (result i32 i32) (call $env_get      (local.get 0) (local.get 1)))
  (func (export "wexel_stdout_write") (param i32 i32)                   (call $stdout_write (local.get 0) (local.get 1)))
  (func (export "wexel_stderr_write") (param i32 i32)                   (call $stderr_write (local.get 0) (local.get 1)))
  (func (export "wexel_proc_exit")    (param i32)                       (call $proc_exit    (local.get 0)))
)
