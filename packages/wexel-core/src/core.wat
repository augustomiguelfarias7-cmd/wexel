(module
  ;; Legacy WASM32 core artifact. Its linear-memory ceiling is 2 GiB (32768 pages).
  ;; The experimental Memory64 VFS target lives in ../memory64 and configures up to 16 GiB
  ;; of linear memory; it is not the default package artifact until integration is complete.
  ;; Memory limits do not reserve host RAM at startup.
  (memory (export "memory") 1 32768)
  (global $heap (mut i32) (i32.const 1024))
  (global $yield_counter (mut i32) (i32.const 0))

  (func (export "alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap))
    (global.set $heap (i32.add (global.get $heap) (local.get $size)))
    (local.get $ptr)
  )

  (func (export "heap_mark") (result i32)
    (global.get $heap)
  )

  (func (export "heap_reset") (param $mark i32)
    (if (i32.ge_u (local.get $mark) (i32.const 1024))
      (then (global.set $heap (local.get $mark))))
  )

  (func (export "memory_limit_pages") (result i32)
    (i32.const 32768)
  )

  (func (export "runtime_version") (result i32)
    (i32.const 20001)
  )

  ;; Ponto cooperativo para operações longas do terminal e instaladores.
  (func (export "yield") (result i32)
    (global.set $yield_counter (i32.add (global.get $yield_counter) (i32.const 1)))
    (global.get $yield_counter)
  )

  (func (export "add") (param $a i32) (param $b i32) (result i32)
    (i32.add (local.get $a) (local.get $b))
  )

  (func (export "write_byte") (param $ptr i32) (param $value i32)
    (i32.store8 (local.get $ptr) (local.get $value))
  )
)
