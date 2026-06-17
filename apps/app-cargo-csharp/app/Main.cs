using System;
using System.Net;
using System.Text;

class Program
{
    static void Main()
    {
        string webhook = Environment.GetEnvironmentVariable("WEBHOOK_URL");
        string webhookIp = Environment.GetEnvironmentVariable("WEBHOOK_IP");

        // Demo only: accept any TLS certificate so Mono doesn't need a synced
        // CA store. Do NOT do this in production code.
        ServicePointManager.ServerCertificateValidationCallback =
            (sender, cert, chain, errors) => true;

        // Mono's managed DNS resolver fails under proot and ignores /etc/hosts.
        // start.sh pre-resolves the host with libc and passes the IP in
        // WEBHOOK_IP — connect to the IP directly and send the real hostname in
        // the Host header so Mono never performs a DNS lookup.
        var uri = new Uri(webhook);
        string targetUrl = webhook;
        if (!string.IsNullOrEmpty(webhookIp))
        {
            var b = new UriBuilder(uri) { Host = webhookIp };
            targetUrl = b.Uri.ToString();
        }

        string body = "{\"language\":\"C#\",\"runtime\":\".NET "
            + Environment.Version
            + "\",\"message\":\"Hello from C# running on Acurast!\"}";

        var request = (HttpWebRequest)WebRequest.Create(targetUrl);
        request.Host = uri.Host;
        request.Method = "POST";
        request.ContentType = "application/json";
        // Without these a stalled connect/read blocks forever under proot,
        // outlasting the job and reporting nothing. Time out so a hang surfaces
        // as a non-zero exit that start.sh can report.
        request.Timeout = 30000;
        request.ReadWriteTimeout = 30000;

        byte[] data = Encoding.UTF8.GetBytes(body);
        using (var stream = request.GetRequestStream())
        {
            stream.Write(data, 0, data.Length);
        }

        using (var response = (HttpWebResponse)request.GetResponse())
        {
            Console.WriteLine("posted: " + (int)response.StatusCode);
        }
    }
}
