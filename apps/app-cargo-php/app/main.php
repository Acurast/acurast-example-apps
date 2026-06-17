<?php

$webhook = getenv("WEBHOOK_URL");
$body = json_encode([
    "language" => "PHP",
    "runtime" => "PHP " . phpversion(),
    "message" => "Hello from PHP running on Acurast!",
]);

$ch = curl_init($webhook);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

$resp = curl_exec($ch);
if ($resp === false) {
    fwrite(STDERR, "POST failed: " . curl_error($ch) . "\n");
    exit(1);
}

echo "posted: " . curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\n";
curl_close($ch);
