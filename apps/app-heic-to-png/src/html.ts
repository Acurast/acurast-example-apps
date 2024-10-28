export const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acurast HEIC to PNG Converter</title>
  <style>
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      font-family: Arial, sans-serif;
      background-color: #f4f6f8;
    }

    .container {
      width: 100%;
      max-width: 400px;
      text-align: center;
    }

    h2 {
      font-size: 1.5em;
      color: #333;
      margin-bottom: 20px;
    }

    .upload-area {
      position: relative;
      border: 2px dashed #ccc;
      border-radius: 8px;
      padding: 40px 20px;
      background-color: #fff;
      transition: 0.3s;
      cursor: pointer;
    }

    .upload-area:hover {
      border-color: #007bff;
      background-color: #f8f9fa;
    }

    .upload-area.drag-over {
      border-color: #007bff;
      background-color: #e9ecef;
    }

    .upload-area p {
      margin: 0;
      font-size: 1em;
      color: #666;
    }

    .file-url {
      margin-top: 20px;
      font-size: 0.9em;
      color: #28a745;
      word-break: break-all;
    }

    input[type="file"] {
      display: none;
    }

    /* Spinner Styling */
    .spinner {
      display: none;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 40px;
      border: 4px solid #ccc;
      border-top: 4px solid #007bff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      0% { transform: translate(-50%, -50%) rotate(0deg); }
      100% { transform: translate(-50%, -50%) rotate(360deg); }
    }

    .uploading .spinner {
      display: block;
    }

    .uploading p {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h2>Acurast HEIC to PNG Converter</h2>
    <div class="upload-area" id="uploadArea">
      <p>Drag & Drop a HEIC file or <span style="color: #007bff;">click here</span></p>
      <div class="spinner" id="spinner"></div>
      <input type="file" id="fileInput" accept=".heic">
    </div>
    <div class="file-url" id="fileUrl"></div>
    <div id="errorMessage" class="error"></div>
  </div>

  <script>
    const uploadArea = document.getElementById("uploadArea");
    const fileInput = document.getElementById("fileInput");
    const fileUrlDisplay = document.getElementById("fileUrl");
    const spinner = document.getElementById("spinner");
    const errorMessage = document.getElementById('errorMessage');

    function showError(message) {
      errorMessage.style.display = 'block';
      errorMessage.textContent = message;
    }

    uploadArea.addEventListener("click", () => fileInput.click());

    uploadArea.addEventListener("dragover", (event) => {
      event.preventDefault();
      uploadArea.classList.add("drag-over");
    });

    uploadArea.addEventListener("dragleave", () => {
      uploadArea.classList.remove("drag-over");
    });

    uploadArea.addEventListener("drop", (event) => {
      event.preventDefault();
      uploadArea.classList.remove("drag-over");
      if (event.dataTransfer.files.length) {
        handleFileUpload(event.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) {
        handleFileUpload(fileInput.files[0]);
      }
    });

    async function checkStatus(id) {
      try {
        // Placeholder for actual file upload logic
        console.log("File uploaded:");

        // Simulate server polling for the converted file
        const pollingInterval = setInterval(async () => {
          try {
            console.log('STARTING POLLING');
            const response = await fetch(\`processed/\${id}\`);
            const result = await response.json();

            if (result.success) {
              clearInterval(pollingInterval);
              fileUrlDisplay.innerHTML = \`Download your file: <a href="\${result.url}" target="_blank">Click here</a>\`;
              uploadArea.classList.remove("uploading");
            }
          } catch (error) {
            console.error("Error checking file status:", error);
          }
        }, 2000); // polling every 2 seconds
      } catch (error) {
        console.error("Error uploading file:", error);
        alert("File upload failed.");
      }
    }

    async function handleFileUpload(file) {
      if (file.type !== "image/heic") {
        alert("Please upload a HEIC file.");
        return;
      }

      // Show spinner
      uploadArea.classList.add("uploading");

      const formData = new FormData();
      formData.append('image', file);

      fetch('/upload', {
        method: 'POST',
        body: formData
      })
      .then(response => response.json())
      .then(result => {
        console.log(result);
        if (result.success) {
          checkStatus(result.id);
        } else {
          showError(result.error);
        }
      })
      .catch(error => {
        console.error('Error:', error);
        showError('Upload failed. Please try again.');
      }).finally(() => {
        uploadArea.classList.remove("uploading");
      });
    }
  </script>
</body>
</html>
`;
