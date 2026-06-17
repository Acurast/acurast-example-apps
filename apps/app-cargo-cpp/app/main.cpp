#include <cstdlib>
#include <iostream>
#include <string>
#include <curl/curl.h>

int main() {
    const char* webhook = std::getenv("WEBHOOK_URL");
    if (!webhook) {
        std::cerr << "WEBHOOK_URL not set\n";
        return 1;
    }

    std::string body =
        std::string("{\"language\":\"C++\",\"runtime\":\"g++ ") + __VERSION__ +
        "\",\"message\":\"Hello from C++ running on Acurast!\"}";

    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "curl init failed\n";
        return 1;
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, webhook);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        std::cerr << "POST failed: " << curl_easy_strerror(res) << "\n";
        return 1;
    }

    long code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    std::cout << "posted: " << code << "\n";

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    curl_global_cleanup();
    return 0;
}
