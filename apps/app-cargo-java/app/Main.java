import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class Main {
    public static void main(String[] args) throws Exception {
        String webhook = System.getenv("WEBHOOK_URL");
        String body = "{\"language\":\"Java\",\"runtime\":\"Java "
                + System.getProperty("java.version")
                + "\",\"message\":\"Hello from Java running on Acurast!\"}";

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(webhook))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response =
                client.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println("posted: " + response.statusCode());
    }
}
