import puppeteer from "puppeteer-core";

declare const _STD_: any;

const API_URL = "https://freeipapi.com/api/json";
const WEBHOOK_URL = "https://webhook.site/3b8ff133-11df-4762-9af4-acd9325cb4c6";

const searchQuery = "acurast";

_STD_.webview.open(
  "https://www.google.com/",
  () => {
    const WS_ENDPOINT = `${_STD_.webview.getDebugUrl()}/devtools/browser`;

    const connectToWs = async (browserWSEndpoint: string) => {
      const browser = await puppeteer.connect({ browserWSEndpoint });

      console.log("browser connected");

      const [page] = await browser.pages();
      await page.setRequestInterception(true);
      await page.setJavaScriptEnabled(false);

      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      );

      page.on("request", (request) => {
        request.resourceType() === "document"
          ? request.continue()
          : request.abort();
      });

      const URL = `https://www.google.com/search?q=${searchQuery}`;

      console.log("Page opened", URL);

      await page.goto(URL, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForNetworkIdle();

      const pageData = await page.evaluate(() => {
        // Function to recursively extract text content of lowest level children nodes
        const extractTextContent = (element: HTMLElement | ChildNode) => {
          let textContent: any = [];

          // Get all children nodes of the current element
          const children = element.childNodes;

          // Iterate over each child node
          for (let child of children) {
            // If the node is a text node (nodeType === 3), extract its text content
            if (child.nodeType === 3 && child.textContent?.trim() !== "") {
              textContent.push(child.textContent?.trim());
            }
            // If the node has children, recursively extract their text content
            if (child.childNodes.length > 0) {
              const childTextContent = extractTextContent(child);
              textContent = textContent.concat(childTextContent);
            }
          }

          return textContent;
        };

        const results: any = [];

        // Select all <h3> elements
        const h3Elements = document.querySelectorAll("h3");

        h3Elements.forEach((h3) => {
          // Find the nearest container element that holds both <h3> and <a> tags
          let container = h3.parentElement;
          while (container) {
            // Check if the container has an <a> tag
            const a = container.querySelector("a");
            if (a) {
              const headingText = h3.textContent?.trim();
              const link = a.getAttribute("href");

              const itemContainer = container.parentElement;

              if (itemContainer) {
                const descriptions: any[] = extractTextContent(itemContainer);

                results.push({
                  heading: headingText,
                  link: link,
                  description: descriptions,
                });
              }
              break; // Exit loop once found
            }
            // Move up to the parent container
            container = container.parentElement;
          }
        });

        return results;
      });

      console.log("pageData", pageData);

      fetch(API_URL)
        .then((response) => response.json())
        .then((data) => {
          console.log("Fetched");

          const report = {
            timestamp: Date.now(),
            type: "GOOGLE_SEARCH",
            term: searchQuery,
            data,
            pageData,
            acurast: {
              version: _STD_.app_info.version,
              deviceAddress: _STD_.device.getAddress(),
              deployment: {
                id: _STD_.job.getId(),
                slot: _STD_.job.getSlot(),
                script: _STD_.scriptHash,
              },
            },
          };

          // Send the sum to a webhook
          fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(report),
          })
            .then((data) =>
              console.log("Success:", data.status, data.statusText)
            )
            .catch((error) => console.error("Error posting data:", error));
        })
        .catch((error) => console.error("Error fetching data:", error));

      // Close the browser
      await browser.close();
    };

    (async () => {
      try {
        await connectToWs(WS_ENDPOINT);
      } catch (e) {
        console.log(e);
      }
    })();
  },
  console.log
);
