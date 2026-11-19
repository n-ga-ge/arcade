// Install a Nokia firmware (a VPL file and the FPSX images it names) into an
// EKA2L1 data folder, without a user interface.
//
//   node install_firmware.js <vpl> <data dir> [variant]
//
// tools/devices/install.py compiles this against the static libraries of a web
// build of the fork and runs it under Node (NODERAWFS, so paths are the host's).
// It calls the same eka2l1::install_firmware() as the desktop frontend's
// "install device" dialog, which is the only other way to reach it: the control
// API has no firmware install.
//
// The data folder must already hold roms/, drives/z/ and drives/c/; the driver
// creates them. Exit status: 0 installed, 1 install failed, 2 bad arguments.

#include <common/log.h>
#include <common/path.h>
#include <config/config.h>
#include <system/devices.h>
#include <system/installation/firmware.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {
    const char *error_name(const eka2l1::device_installation_error err) {
        switch (err) {
        case eka2l1::device_installation_not_exist:
            return "a file does not exist";
        case eka2l1::device_installation_insufficent:
            return "not enough space";
        case eka2l1::device_installation_determine_product_failure:
            return "the firmware's product code could not be read from drive Z";
        case eka2l1::device_installation_already_exist:
            return "a device with this firmware code is already installed in the data folder";
        case eka2l1::device_installation_general_failure:
            return "general failure (often a missing folder or an unwritable data folder)";
        case eka2l1::device_installation_rom_fail_to_copy:
            return "the ROM could not be copied";
        case eka2l1::device_installation_vpl_file_invalid:
            return "the VPL file is invalid or names no Mcu/Ppm/Content image that exists beside it";
        case eka2l1::device_installation_rofs_corrupt:
            return "a ROFS image is corrupt";
        case eka2l1::device_installation_rom_file_corrupt:
            return "the ROM image is corrupt";
        case eka2l1::device_installation_fpsx_corrupt:
            return "an FPSX file is corrupt";
        default:
            return "unknown error";
        }
    }
}

int main(int argc, char **argv) {
    if (argc < 3 || argc > 4) {
        std::fprintf(stderr, "usage: install_firmware <vpl> <data dir> [variant]\n");
        return 2;
    }

    int variant = 0;
    if (argc == 4) {
        char *end = nullptr;
        const long value = std::strtol(argv[3], &end, 10);
        if ((end == argv[3]) || (*end != '\0') || (value < 0) || (value > 1000)) {
            std::fprintf(stderr, "install_firmware: variant must be a number from 0\n");
            return 2;
        }
        variant = static_cast<int>(value);
    }

    // Errors of the installer go to the console; the log file EKA2L1.log lands
    // in the current folder, which the driver sets to the tool's own folder.
    eka2l1::log::setup_log(nullptr);
    if (!eka2l1::log::is_console_enabled()) {
        eka2l1::log::toggle_console();
    }
    if (eka2l1::log::filterings) {
        eka2l1::log::filterings->parse_filter_string("*:warn");
    }

    eka2l1::config::state conf;
    conf.storage = argv[2];

    eka2l1::device_manager manager(&conf);
    const std::string roms = eka2l1::add_path(conf.storage, "roms/");
    int last = -10;
    bool variant_valid = true;

    const auto err = eka2l1::install_firmware(&manager, argv[1], conf.storage, roms, false,
        [&](const std::vector<std::string> &variants) {
            for (std::size_t i = 0; i < variants.size(); i++) {
                std::printf("variant %zu%s: %s\n", i, (static_cast<int>(i) == variant) ? " (chosen)" : "",
                    variants[i].c_str());
            }
            if (variant >= static_cast<int>(variants.size())) {
                variant_valid = false;
            }
            return variant;
        },
        [&](const std::size_t done, const std::size_t total) {
            const int percent = total ? static_cast<int>(done * 100 / total) : 0;
            // The installer's own figures can step back between images; print only progress.
            if ((percent >= last + 10) || ((percent == 100) && (last != 100))) {
                last = percent;
                std::printf("progress %d%%\n", percent);
                std::fflush(stdout);
            }
        },
        [] { return false; });

    if (!variant_valid) {
        std::fprintf(stderr, "install_firmware: the VPL has no variant %d\n", variant);
        return 1;
    }

    if (err != eka2l1::device_installation_none) {
        std::fprintf(stderr, "install_firmware: install failed (error %d): %s\n", static_cast<int>(err),
            error_name(err));
        return 1;
    }

    manager.save_devices();
    for (auto &device : manager.get_devices()) {
        std::printf("device: %s | %s | %s\n", device.firmware_code.c_str(), device.manufacturer.c_str(),
            device.model.c_str());
    }
    return 0;
}

// The libraries reference the frontend's text input dialog; a firmware install
// never opens one.
#include <drivers/ui/input_dialog.h>

namespace eka2l1::drivers::ui {
    bool open_input_view(const std::u16string &, const int, input_dialog_complete_callback) {
        return false;
    }

    void close_input_view() {
    }
}
