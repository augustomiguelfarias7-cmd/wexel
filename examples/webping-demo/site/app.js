const status = document.querySelector("#status");
const output = document.querySelector("#output");

fetch("./data.json")
  .then((response) => {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  })
  .then((data) => {
    status.textContent = "Site carregado do VFS.";
    output.textContent = JSON.stringify(data, null, 2);
  })
  .catch((error) => {
    status.textContent = "Falha ao carregar data.json";
    output.textContent = String(error);
  });
