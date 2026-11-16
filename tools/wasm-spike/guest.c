// Guest workload for the interpreter speed spike. Freestanding ARMv4T (the N-Gage CPU),
// shaped like a 2004 software-rendered game frame: textured spans with fixed-point
// stepping and palette lighting into a 176x208 16-bit framebuffer, plus branchy
// "game logic" with calls, a sort and byte copies. No division, no libc.
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32; typedef int s32;

#define W 176
#define H 208
static u8 tex[64 * 64];
static u16 pal[256 * 8];      // 8 light levels
static u16 fb[W * H];
static u16 back[W * H];
static u32 ents[64];
volatile u32 frames __attribute__((section(".counter")));

static u32 seed = 12345;
static __attribute__((noinline)) u32 rnd(void) { seed = seed * 1664525u + 1013904223u; return seed >> 8; }

static __attribute__((noinline)) void span(u16 *dst, s32 n, u32 u, u32 v, s32 du, s32 dv, const u16 *lp) {
    while (n-- > 0) {
        u32 t = tex[((v >> 10) & 0xFC0) | ((u >> 16) & 63)];
        *dst++ = lp[t];
        u += du; v += dv;
    }
}

static __attribute__((noinline)) void render(u32 phase) {
    for (s32 y = 0; y < H; y++) {
        s32 d = y - H / 2; if (d < 0) d = -d; d += 8;
        u32 light = (u32)d >> 4; if (light > 7) light = 7;
        s32 du = (s32)(0x280000u >> (d >> 3)) + 0x4000;
        s32 dv = (s32)(phase & 0xFFFF) - 0x8000 + (y << 6);
        span(back + y * W, W, phase * 977u + (u32)y * 0x12345u, phase * 331u, du, dv, pal + light * 256);
    }
}

static __attribute__((noinline)) void blit(void) {
    const u32 *s = (const u32 *)back; u32 *d = (u32 *)fb;
    for (s32 i = 0; i < W * H / 2; i++) d[i] = s[i];
}

static __attribute__((noinline)) void logic(void) {
    for (s32 i = 0; i < 64; i++) {
        u32 e = ents[i], r = rnd();
        if (r & 1) e += r & 0xFF; else if (r & 2) e ^= r << 3; else e = (e >> 1) | (e << 31);
        if ((e & 0xF00) == 0x300) e += ents[(i + 7) & 63];
        ents[i] = e;
    }
    for (s32 i = 1; i < 64; i++) {            // insertion sort
        u32 k = ents[i]; s32 j = i - 1;
        while (j >= 0 && ents[j] > k) { ents[j + 1] = ents[j]; j--; }
        ents[j + 1] = k;
    }
    u8 *p = (u8 *)fb; u32 h = 0;
    for (s32 i = 0; i < 4096; i++) h = (h ^ p[i * 7]) * 16777619u;   // byte-wise hash
    ents[h & 63] ^= h;
}

void bench_main(void) {
    for (s32 i = 0; i < 64 * 64; i++) tex[i] = (u8)((i ^ (i >> 6)) * 37);
    for (s32 l = 0; l < 8; l++)
        for (s32 i = 0; i < 256; i++) {
            u32 r = (i >> 3) * (8 - l) >> 3, g = (i >> 2) * (8 - l) >> 3, b = ((i * 3) & 31) * (8 - l) >> 3;
            pal[l * 256 + i] = (u16)((r << 11) | (g << 5) | b);
        }
    for (s32 i = 0; i < 64; i++) ents[i] = rnd();
    for (u32 phase = 0;; phase++) { render(phase); blit(); logic(); frames++; }
}
