// Interpreter speed spike: run an ARMv4T guest workload on EKA2L1's dyncom interpreter
// and report guest MIPS. Built unchanged for native (g++) and WASM (em++).
#include <cpu/dyncom/arm_dyncom.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "guest_arm.h"
#include "guest_thumb.h"

using namespace eka2l1;

static constexpr std::uint32_t BASE = 0x00400000, SIZE = 0x00400000, PAGE_BITS = 12;
static std::vector<std::uint8_t> ram;
static arm::dyncom_core *core_ptr;

template <typename T>
static bool rd(std::uint32_t addr, T *out) {
    if (addr < BASE || addr - BASE + sizeof(T) > SIZE) return false;
    std::memcpy(out, &ram[addr - BASE], sizeof(T));
    const std::uint32_t page = addr & ~((1u << PAGE_BITS) - 1);
    core_ptr->set_tlb_page(page, &ram[page - BASE], prot_read_write_exec);   // refill like the real MMU
    return true;
}
template <typename T>
static bool wr(std::uint32_t addr, T *in) {
    if (addr < BASE || addr - BASE + sizeof(T) > SIZE) return false;
    std::memcpy(&ram[addr - BASE], in, sizeof(T));
    const std::uint32_t page = addr & ~((1u << PAGE_BITS) - 1);
    core_ptr->set_tlb_page(page, &ram[page - BASE], prot_read_write_exec);
    return true;
}

static double run(const char *name, const unsigned char *bin, unsigned len, std::uint32_t entry, bool thumb, double seconds, std::uint32_t slice) {
    ram.assign(SIZE, 0);
    std::memcpy(ram.data(), bin, len);
    arm::dyncom_core core(nullptr, PAGE_BITS);
    core_ptr = &core;
    core.read_8bit = [](std::uint32_t a, std::uint8_t *v) { return rd(a, v); };
    core.read_16bit = [](std::uint32_t a, std::uint16_t *v) { return rd(a, v); };
    core.read_32bit = [](std::uint32_t a, std::uint32_t *v) { return rd(a, v); };
    core.read_64bit = [](std::uint32_t a, std::uint64_t *v) { return rd(a, v); };
    core.read_code = [](std::uint32_t a, std::uint32_t *v) { return rd(a, v); };
    core.write_8bit = [](std::uint32_t a, std::uint8_t *v) { return wr(a, v); };
    core.write_16bit = [](std::uint32_t a, std::uint16_t *v) { return wr(a, v); };
    core.write_32bit = [](std::uint32_t a, std::uint32_t *v) { return wr(a, v); };
    core.write_64bit = [](std::uint32_t a, std::uint64_t *v) { return wr(a, v); };
    core.system_call_handler = [](std::uint32_t) {};
    core.exception_handler = [&](arm::exception_type t, std::uint32_t d) {
        std::printf("guest exception %d data=%08x pc=%08x\n", (int)t, d, core.get_pc());
        for (int i = 0; i < 16; i++) std::printf("r%d=%08x ", i, core.get_reg(i));
        std::printf("cpsr=%08x\n", core.get_cpsr());
        std::exit(1);
        return false;
    };
    core.set_cpsr(0x10 | (thumb ? 0x20 : 0));
    core.set_sp(BASE + SIZE - 16);
    core.set_pc(entry);

    using clock = std::chrono::steady_clock;
    const auto t0 = clock::now();
    std::uint64_t insts = 0;
    double el = 0;
    do {
        for (int i = 0; i < 200; i++) {
            core.run(slice);
            insts += core.get_num_instruction_executed();
        }
        el = std::chrono::duration<double>(clock::now() - t0).count();
    } while (el < seconds);
    std::uint32_t frames;
    std::memcpy(&frames, &ram[0x00500000 - BASE], 4);
    std::printf("%-6s %8.1f MIPS  %7.1f guest frames/s  (%.2fs, %llu insts, %u frames)\n", name, insts / el / 1e6,
        frames / el, el, (unsigned long long)insts, frames);
    return insts / el / 1e6;
}

int main(int argc, char **argv) {
    const double secs = argc > 1 ? std::atof(argv[1]) : 5.0;
    const std::uint32_t slice = argc > 2 ? std::strtoul(argv[2], nullptr, 0) : 20000;
    run("arm", guest_arm_bin, guest_arm_bin_len, guest_arm_entry, false, secs, slice);
    run("thumb", guest_thumb_bin, guest_thumb_bin_len, guest_thumb_entry, false, secs, slice);
    return 0;
}
