const TYPES = {
    "f64": [64, "Float", false],
    "f32": [32, "Float", false],
    "u32": [32, "Uint", false],
    "u16": [16, "Uint", false],
    "u8": [8, "Uint", false],
    "i32": [32, "Int", true],
    "i16": [16, "Int", true],
    "i8": [8, "Int", true],
};

let align = (bitOffset: number, type: string, spec: any) => {
    if (type == "union") {
        spec = (spec.__spec || spec);
        let a = 0, f;
        for (let i = 0; i < spec.length; i++) {
            f = spec[i];
            a = Math.max(align(bitOffset, f[1], f[2]), a);
        }
        return a;
    } else if (type == "struct") {
        spec = (spec.__spec || spec)[0];
        return align(bitOffset, spec[1], spec[2]);
    }
    let block = TYPES[type][0];
    return block > 8 ? (bitOffset + block - 1) & -block : bitOffset;
};

let isBitField = (f: any[]) => typeof f[2] === "number" && /^(u|i)\d+$/.test(f[1]);

let maybePad = (offset: number, spec: any[], i: number) => {
    let f = spec[i], width;
    if (i == spec.length - 1 || !isBitField(spec[i + 1])) {
        width = TYPES[f[1]][0];
        offset += ((offset + width) & ~(width - 1)) - offset;
    }
    return offset;
};

export let sizeOf = (fields: any[], bitOffset = 0, doAlign = true, union = false) => {
    for (let i = 0; i < fields.length; i++) {
        let f = fields[i], type = f[1], spec = f[2], isBF = isBitField(f);
        bitOffset = doAlign && !isBF ? align(bitOffset, type, spec) : bitOffset;
        if (type === "union" || type === "struct") {
            bitOffset = sizeOf(spec.__spec || spec, bitOffset, doAlign, type === "union");
        } else if (!union) {
            bitOffset += isBF ? spec : TYPES[type][0];
            if (doAlign && isBF) {
                bitOffset = maybePad(bitOffset, fields, i);
            }
        }
    }
    return bitOffset;
};

let bitReader = (dv: DataView, byteOffset: number, bit: number, size: number) => {
    let b = bit - size, g = "getUint32";
    if (b >= 0) {
        return () => dv[g](byteOffset, false) >>> b & (1 << size) - 1;
    }
    return () => ((dv[g](byteOffset, false) & (1 << bit) - 1) << -b) |
        (dv[g](byteOffset + 4, false) >>> (32 + b));
};

let bitWriter = (dv: DataView, byteOffset: number, bit: number, size: number) => {
    let b = bit - size,
        m = bit < 32 ? ~((1 << bit) - 1) : 0,
        g = "getUint32",
        s = "setUint32";
    if (b >= 0) {
        m |= (1 << b) - 1;
        return (x) => {
            dv[s](byteOffset, (dv[g](byteOffset, false) & m) | (x << b & ~m), false);
        };
    } else {
        let bb = 32 + b;
        return (x) => {
            dv[s](byteOffset, (dv[g](byteOffset, false) & m) | (x >>> -b & ~m), false);
            dv[s](byteOffset + 4, (dv[g](byteOffset + 4, false) & (1 << bb) - 1) | x << bb, false);
        }
    }
};

let makeField = (field: any[], obj: any, dv: DataView, bitOffset: number, doAlign: boolean, le: boolean) => {
    let [id, type, size] = field,
        isBF = isBitField(field);
    bitOffset = doAlign && !isBF ? align(bitOffset, type, size) : bitOffset;
    let byteOffset = bitOffset >>> 3;
    obj.__offsets[id] = byteOffset;
    if (type === "union" || type === "struct") {
        let f = typedef(size.__spec || size, type === "struct", dv.buffer, byteOffset, doAlign, le);
        Object.defineProperty(obj, id, {
            get: () => f,
            enumerable: true,
            configurable: false
        });
        bitOffset += ((f as any).__size << 3);
    } else {
        let [dsize, typeid, signed] = TYPES[type],
            shift = 32 - size,
            get, set, read, write;
        if (isBF) {
            obj.__offsets[id] = (byteOffset &= -4);
            let bitPos = 32 - (bitOffset & 0x1f);
            read = bitReader(dv, byteOffset, bitPos, size);
            get = signed ? () => (read() << shift) >> shift : read;
            set = bitWriter(dv, byteOffset, bitPos, size);
            bitOffset += size;
        } else {
            read = dv[`get${typeid}${dsize}`];
            write = dv[`set${typeid}${dsize}`];
            get = signed ?
                () => (read.call(dv, byteOffset, le) << shift) >> shift :
                () => read.call(dv, byteOffset, le);
            set = signed ?
                (x: number) => write.call(dv, byteOffset, (x << shift) >> shift, le) :
                (x: number) => write.call(dv, byteOffset, x, le);
            bitOffset += dsize;
        }
        Object.defineProperty(obj, id, {
            get,
            set,
            enumerable: true,
            configurable: false
        });
    }
    return bitOffset;
};

export let typedef = (spec: any[], struct: boolean, buf?: ArrayBuffer, offset = 0, doAlign = true, le = false) => {
    let size = sizeOf(spec, 0, doAlign, !struct) >>> 3,
        dv = new DataView(buf || new ArrayBuffer(size)),
        off = offset << 3,
        obj = {
            __buffer: dv.buffer,
            __spec: spec,
            __size: size,
            __offsets: <any>{}
        };
    for (let i = 0; i < spec.length; i++) {
        let f = spec[i];
        offset = makeField(f, obj, dv, off, doAlign, le);
        if (doAlign && isBitField(f)) {
            offset = maybePad(offset, spec, i);
        }
        if (struct) {
            off = offset;
        }
    }
    return obj;
};

export let union = (spec: any[], buf?: ArrayBuffer, offset?: number, doAlign?: boolean, le?: boolean) => {
    return typedef(spec, false, buf, offset, doAlign, le);
}

export let struct = (spec: any[], buf?: ArrayBuffer, offset?: number, doAlign?: boolean, le?: boolean) => {
    return typedef(spec, true, buf, offset, doAlign, le);
}
