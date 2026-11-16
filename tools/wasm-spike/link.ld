ENTRY(_start)
SECTIONS {
  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) }
  . = 0x00400000;
  .text : { *(.text.start) *(.text*) *(.rodata*) }
  .data : { *(.data*) }
  . = 0x00500000;
  .counter : { *(.counter) }
  .bss : { *(.bss*) *(COMMON) }
}
