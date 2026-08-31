// PRD: §9 — Shared minimal Xtensa LX6 assembler + ELF32 writer for golden fixtures.
// Extracted from make-blink-elf.mjs (P0.3) so dev-plan task P1.2 (make-i2c-elf.mjs)
// can emit a second firmware without duplicating the encoder tables.
//
// No cross-toolchain is required: instruction words are encoded directly below.
// Encodings and PC-relative semantics follow the decoder tables shipped with the
// pinned QEMU release (espressif/qemu esp-develop-9.2.2-20260417,
// target/xtensa/core-esp32/xtensa-modules.inc.c) and are validated by running the
// ELFs under `qemu-system-xtensa -M esp32 -kernel`.
//
// Word layout: op0[3:0] | t[7:4] | s[11:8] | r[15:12] | op1[19:16] | op2[23:20].
//   L32R  op0=1, at=t, imm16[23:8]           -> vAddr = ((pc+3)&~3) + sign18(imm16<<2)
//   MOVI  op0=2, at=t, r=10, simm12b         -> imm[11:8] in s field, imm[7:0] in bits 23..16
//   ADDI  op0=2, at=t, as=s, r=12, simm8[23:16]
//   L8UI  op0=2, at=t, as=s, r=0,  uimm8[23:16]
//   S8I   op0=2, at=t, as=s, r=4,  uimm8[23:16]
//   S32I  op0=2, at=t, as=s, r=6,  uimm8x4[23:16]
//   BNEZ  op0=6, n=1, m=1, as=s, label12[23:12] -> target = pc + 4 + simm12
//   J     op0=6, n=0, offset18[23:6]            -> target = pc + 4 + simm18

export function assertRange(what, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`[BB-002] ${what} out of range: ${v} (expected ${lo}..${hi})`);
  }
}

export function encL32r(at, imm16) {
  return 0x1 | ((at & 0xf) << 4) | ((imm16 & 0xffff) << 8);
}

export function encMovi(at, imm12) {
  assertRange('movi imm12', imm12, -2048, 2047);
  const v = imm12 & 0xfff;
  // simm12b is split: low 8 bits go to bits 23..16, high 4 bits to bits 11..8 (s field).
  return 0x2 | ((at & 0xf) << 4) | ((v >> 8) << 8) | (0xa << 12) | ((v & 0xff) << 16);
}

export function encAddi(at, as, imm8) {
  assertRange('addi imm8', imm8, -128, 127);
  return 0x2 | ((at & 0xf) << 4) | ((as & 0xf) << 8) | (0xc << 12) | ((imm8 & 0xff) << 16);
}

export function encL8ui(at, as, off8) {
  assertRange('l8ui offset', off8, 0, 255);
  return 0x2 | ((at & 0xf) << 4) | ((as & 0xf) << 8) | (0x0 << 12) | (off8 << 16);
}

export function encS8i(at, as, off8) {
  assertRange('s8i offset', off8, 0, 255);
  return 0x2 | ((at & 0xf) << 4) | ((as & 0xf) << 8) | (0x4 << 12) | (off8 << 16);
}

export function encS32i(at, as, off8x4) {
  assertRange('s32i offset', off8x4, 0, 1020);
  if (off8x4 % 4 !== 0) throw new Error(`[BB-002] s32i offset must be word aligned: ${off8x4}`);
  return 0x2 | ((at & 0xf) << 4) | ((as & 0xf) << 8) | (0x6 << 12) | ((off8x4 >> 2) << 16);
}

export function encBnez(as, rel12) {
  assertRange('bnez offset', rel12, -2048, 2047);
  return 0x6 | (1 << 4) | (1 << 6) | ((as & 0xf) << 8) | ((rel12 & 0xfff) << 12);
}

export function encJ(rel18) {
  assertRange('j offset', rel18, -(1 << 17), (1 << 17) - 1);
  return 0x6 | ((rel18 & 0x3ffff) << 6);
}

export const wordHex = (w) => w.toString(16).padStart(6, '0');

/**
 * Minimal two-pass assembler. Layout: 4-byte literal pool, then string blobs,
 * then instructions (3 bytes each). 3-byte `addi a0,a0,0` fillers keep every
 * l32r on a 4-byte boundary so ((pc+3)&~3) === pc.
 *
 * A literal's value may be a number or `(addrOf) => number`, where addrOf maps
 * symbol/string names to their final address — used to point at string blobs.
 */
export class Program {
  constructor(base) {
    this.base = base;
    this.literals = new Map(); // name -> number | (addrOf) => number, pool order
    this.strings = new Map();  // name -> Buffer, placed after the word literals
    this.items = []; // { kind: 'insn' | 'label', ... }
  }

  /** Add a 4-byte literal word (or a callback resolving against final addresses). */
  literal(name, value) {
    if (this.literals.has(name)) throw new Error(`[BB-002] duplicate literal ${name}`);
    this.literals.set(name, value);
    return name;
  }

  /** Add a string blob; its address is resolvable by name via literal callbacks. */
  string(name, bytes) {
    if (this.strings.has(name)) throw new Error(`[BB-002] duplicate string ${name}`);
    this.strings.set(name, bytes);
    return name;
  }

  label(name) {
    this.items.push({ kind: 'label', name });
  }

  insn(op, text, fields) {
    this.items.push({ kind: 'insn', op, text, ...fields });
  }

  assemble() {
    const poolBytes = [];
    const litAddr = new Map();
    let off = 0;
    const pendingFixups = [];
    for (const [name, value] of this.literals) {
      litAddr.set(name, this.base + off);
      pendingFixups.push({ name, value, offset: off });
      poolBytes.push(0, 0, 0, 0);
      off += 4;
    }
    for (const [name, bytes] of this.strings) {
      litAddr.set(name, this.base + off);
      poolBytes.push(...bytes);
      off += bytes.length;
    }
    if (this.strings.size > 0) {
      while (off % 4 !== 0) {
        poolBytes.push(0);
        off += 1;
      }
    }
    const addrOf = (name) => {
      if (!litAddr.has(name)) throw new Error(`[BB-002] unresolved symbol ${name}`);
      return litAddr.get(name);
    };
    for (const f of pendingFixups) {
      const v = typeof f.value === 'function' ? f.value(addrOf) : f.value;
      if (!Number.isInteger(v)) throw new Error(`[BB-002] literal ${f.name} resolved to non-integer ${v}`);
      poolBytes[f.offset] = v & 0xff;
      poolBytes[f.offset + 1] = (v >>> 8) & 0xff;
      poolBytes[f.offset + 2] = (v >>> 16) & 0xff;
      poolBytes[f.offset + 3] = (v >>> 24) & 0xff;
    }

    // Pass 1: place instructions, resolve label addresses.
    const labelAddr = new Map();
    const placed = [];
    let cur = off;
    let pending = [];
    const place = (op, text, fields) => {
      placed.push({ op, text, at: cur, ...fields });
      cur += 3;
    };
    for (const item of this.items) {
      if (item.kind === 'label') {
        pending.push(item.name);
        continue;
      }
      if (item.op === 'l32r') {
        while (cur % 4 !== 0) {
          place('addi', 'addi  a0, a0, 0   ; alignment filler', { at_: 0, as_: 0, imm: 0 });
        }
      }
      for (const name of pending) labelAddr.set(name, this.base + cur);
      pending = [];
      place(item.op, item.text, {
        at_: item.at_,
        as_: item.as_,
        imm: item.imm,
        off: item.off,
        lit: item.lit,
        target: item.target,
      });
    }
    const endAddr = this.base + cur;
    for (const name of pending) labelAddr.set(name, endAddr);

    // Pass 2: encode with resolved fixups.
    const codeBytes = [];
    const listing = [];
    const addr = (name) => {
      if (litAddr.has(name)) return litAddr.get(name);
      if (labelAddr.has(name)) return labelAddr.get(name);
      throw new Error(`[BB-002] unresolved symbol ${name}`);
    };
    for (const p of placed) {
      const pc = this.base + p.at;
      let w;
      switch (p.op) {
        case 'l32r': {
          const base = (pc + 3) & ~0x3;
          const delta = addr(p.lit) - base;
          if (delta > -4 || delta < -262140 || (delta & 3) !== 0) {
            throw new Error(`[BB-002] literal ${p.lit} unreachable from 0x${pc.toString(16)}`);
          }
          w = encL32r(p.at_, (delta >> 2) & 0xffff);
          break;
        }
        case 'movi':
          w = encMovi(p.at_, p.imm);
          break;
        case 'addi':
          w = encAddi(p.at_, p.as_, p.imm);
          break;
        case 'l8ui':
          w = encL8ui(p.at_, p.as_, p.off);
          break;
        case 's8i':
          w = encS8i(p.at_, p.as_, p.off);
          break;
        case 's32i':
          w = encS32i(p.at_, p.as_, p.off);
          break;
        case 'bnez': {
          const rel = addr(p.target) - (pc + 4);
          w = encBnez(p.as_, rel);
          break;
        }
        case 'j': {
          const rel = addr(p.target) - (pc + 4);
          w = encJ(rel);
          break;
        }
        default:
          throw new Error(`[BB-002] unknown op ${p.op}`);
      }
      codeBytes.push(w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff);
      listing.push(`  0x${pc.toString(16).padEnd(8)} ${wordHex(w)}  ${p.text}`);
    }

    this.image = Buffer.from([...poolBytes, ...codeBytes]);
    this.listing = listing;
    this.symbols = [
      { name: '_start', value: labelAddr.get('_start'), size: labelAddr.get('app_main') - labelAddr.get('_start') },
      { name: 'app_main', value: labelAddr.get('app_main'), size: endAddr - labelAddr.get('app_main') },
    ];
    return this;
  }
}

/**
 * ELF32 (LSB, EM_XTENSA=94, ET_EXEC) writer.
 * Layout: ehdr | phdr | pad | PT_LOAD image | .strtab | .symtab | .shstrtab | section table.
 */
export function buildElf(base, image, entry, symbols) {
  const align = (n, a) => (n + a - 1) & ~(a - 1);
  const shstr = Buffer.from('\0.text\0.symtab\0.strtab\0.shstrtab\0', 'ascii');
  const shstrOff = (name) => shstr.indexOf(`\0${name}\0`) + 1;

  let strTab = Buffer.from([0]);
  const strOff = [];
  for (const s of symbols) {
    strOff.push(strTab.length);
    strTab = Buffer.concat([strTab, Buffer.from(`${s.name}\0`, 'ascii')]);
  }

  const IMG_OFF = 0x100;
  let cursor = IMG_OFF + image.length;
  const strTabOff = align(cursor, 4);
  cursor = strTabOff + strTab.length;
  const symTabOff = align(cursor, 4);
  cursor = symTabOff + (symbols.length + 1) * 16;
  const shstrOff2 = align(cursor, 4);
  cursor = shstrOff2 + shstr.length;
  const shOff = align(cursor, 4);
  const total = shOff + 5 * 40;

  const buf = Buffer.alloc(total);
  // ELF header.
  buf.write('\u007fELF', 0, 'ascii');
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 0x10); // e_type = ET_EXEC
  buf.writeUInt16LE(94, 0x12); // e_machine = EM_XTENSA
  buf.writeUInt32LE(1, 0x14); // e_version
  buf.writeUInt32LE(entry, 0x18); // e_entry
  buf.writeUInt32LE(0x34, 0x1c); // e_phoff
  buf.writeUInt32LE(shOff, 0x20); // e_shoff
  buf.writeUInt32LE(0, 0x24); // e_flags
  buf.writeUInt16LE(52, 0x28); // e_ehsize
  buf.writeUInt16LE(32, 0x2a); // e_phentsize
  buf.writeUInt16LE(1, 0x2c); // e_phnum
  buf.writeUInt16LE(40, 0x2e); // e_shentsize
  buf.writeUInt16LE(5, 0x30); // e_shnum
  buf.writeUInt16LE(4, 0x32); // e_shstrndx
  // Program header: single RWX PT_LOAD covering the whole image at `base`.
  buf.writeUInt32LE(1, 0x34); // p_type = PT_LOAD
  buf.writeUInt32LE(IMG_OFF, 0x38); // p_offset
  buf.writeUInt32LE(base, 0x3c); // p_vaddr
  buf.writeUInt32LE(base, 0x40); // p_paddr
  buf.writeUInt32LE(image.length, 0x44); // p_filesz
  buf.writeUInt32LE(image.length, 0x48); // p_memsz
  buf.writeUInt32LE(7, 0x4c); // p_flags = R|W|X
  buf.writeUInt32LE(0x1000, 0x50); // p_align
  // Image.
  image.copy(buf, IMG_OFF);
  // .strtab, .symtab, .shstrtab.
  strTab.copy(buf, strTabOff);
  shstr.copy(buf, shstrOff2);
  const symBase = symTabOff;
  symbols.forEach((s, i) => {
    const o = symBase + (i + 1) * 16;
    buf.writeUInt32LE(strOff[i], o);
    buf.writeUInt32LE(s.value, o + 4);
    buf.writeUInt32LE(s.size, o + 8);
    buf[o + 12] = 0x10 | 2; // GLOBAL | FUNC
    buf.writeUInt16LE(1, o + 14); // shndx = .text
  });
  // Section headers: NULL, .text, .symtab, .strtab, .shstrtab.
  const SH_FIELD_OFF = { name: 0, type: 4, flags: 8, addr: 12, offset: 16, size: 20, link: 24, info: 28, align: 32, entsize: 36 };
  const sh = (idx, fields) => {
    const o = shOff + idx * 40;
    for (const [k, v] of Object.entries(fields)) buf.writeUInt32LE(v, o + SH_FIELD_OFF[k]);
  };
  sh(1, { name: shstrOff('.text'), type: 1, flags: 0x6, addr: base, offset: IMG_OFF, size: image.length, align: 4 });
  sh(2, { name: shstrOff('.symtab'), type: 2, offset: symTabOff, size: (symbols.length + 1) * 16, link: 3, info: 1, align: 4, entsize: 16 });
  sh(3, { name: shstrOff('.strtab'), type: 3, offset: strTabOff, size: strTab.length, align: 1 });
  sh(4, { name: shstrOff('.shstrtab'), type: 3, offset: shstrOff2, size: shstr.length, align: 1 });
  return buf;
}

/** Built-in ELF sanity check shared by all fixture builders. */
export function elfSanity(elf, entry) {
  const checks = [
    ['ELF magic', elf.subarray(0, 4).toString('ascii') === '\u007fELF'],
    ['ELFCLASS32 + LSB', elf[4] === 1 && elf[5] === 1],
    ['e_machine = EM_XTENSA(94)', elf.readUInt16LE(0x12) === 94],
    ['e_entry = _start', elf.readUInt32LE(0x18) === entry],
  ];
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`[BB-002] self-check failed: ${what}`);
  }
}
