require "net/http"
require "json"
require "uri"

webhook = ENV.fetch("WEBHOOK_URL")
uri = URI(webhook)

body = {
  language: "Ruby",
  runtime: "Ruby #{RUBY_VERSION}",
  message: "Hello from Ruby running on Acurast!",
}.to_json

http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = (uri.scheme == "https")

req = Net::HTTP::Post.new(uri, "Content-Type" => "application/json")
req.body = body

res = http.request(req)
puts "posted: #{res.code}"
