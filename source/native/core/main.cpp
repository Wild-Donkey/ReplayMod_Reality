#include <iostream>
#include <string>

// Version 1 uses one ASCII command and one response per line.
// EOF on stdin also shuts down the sidecar when its parent exits.
int main() {
    std::string command;
    bool ready = false;
    while (std::getline(std::cin, command)) {
        if (!command.empty() && command.back() == '\r') command.pop_back();
        if (command == "hello 1") {
            ready = true;
            std::cout << "ready 1" << std::endl;
        } else if (command == "ping" && ready) {
            std::cout << "pong" << std::endl;
        } else {
            std::cout << "error unsupported-command" << std::endl;
        }
        if (!std::cout) return 1;
    }
    return std::cin.eof() ? 0 : 1;
}
