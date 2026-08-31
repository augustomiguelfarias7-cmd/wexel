(module
  ;; 16 KiB iniciais, limite virtual de 3 GiB (49152 páginas de 64 KiB).
  ;; O limite não reserva RAM; o host pode impor uma capacidade menor.
  (memory (export "memory") 1 49152)
  (global $heap (mut i32) (i32.const 1024))
  (func (export "alloc") (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap))
    (global.set $heap (i32.add (global.get $heap) (local.get $size)))
    (local.get $ptr)
  )
  (func (export "add") (param $a i32) (param $b i32) (result i32)
    (i32.add (local.get $a) (local.get $b))
  )
  (func (export "write_byte") (param $ptr i32) (param $value i32)
    (i32.store8 (local.get $ptr) (local.get $value))
  )
)
