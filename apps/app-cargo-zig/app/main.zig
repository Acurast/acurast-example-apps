const std = @import("std");
const c = @cImport({
    @cInclude("curl/curl.h");
});

pub fn main() void {
    const webhook = std.posix.getenv("WEBHOOK_URL") orelse {
        std.debug.print("WEBHOOK_URL not set\n", .{});
        std.process.exit(1);
    };

    // Double-quoted literal is null-terminated, which CURLOPT_POSTFIELDS needs.
    const body = "{\"language\":\"Zig\",\"runtime\":\"Zig\",\"message\":\"Hello from Zig running on Acurast!\"}";

    _ = c.curl_global_init(c.CURL_GLOBAL_DEFAULT);
    const curl = c.curl_easy_init() orelse {
        std.debug.print("curl init failed\n", .{});
        std.process.exit(1);
    };
    defer c.curl_easy_cleanup(curl);

    var headers: [*c]c.curl_slist = null;
    headers = c.curl_slist_append(headers, "Content-Type: application/json");
    defer c.curl_slist_free_all(headers);

    _ = c.curl_easy_setopt(curl, c.CURLOPT_URL, webhook.ptr);
    _ = c.curl_easy_setopt(curl, c.CURLOPT_HTTPHEADER, headers);
    _ = c.curl_easy_setopt(curl, c.CURLOPT_POSTFIELDS, body.ptr);

    const res = c.curl_easy_perform(curl);
    if (res != c.CURLE_OK) {
        std.debug.print("POST failed: {s}\n", .{std.mem.span(c.curl_easy_strerror(res))});
        std.process.exit(1);
    }

    var code: c_long = 0;
    _ = c.curl_easy_getinfo(curl, c.CURLINFO_RESPONSE_CODE, &code);
    std.debug.print("posted: {d}\n", .{code});
}
