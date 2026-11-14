import { toAddress } from "./address";

it("turns address bar input into http(s) URLs or a search", () => {
  expect(toAddress("https://example.com/a")).toBe("https://example.com/a");
  expect(toAddress("example.com")).toBe("https://example.com/");
  expect(toAddress("localhost:1420")).toBe("http://localhost:1420/");
  expect(toAddress("127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000/x");
  expect(toAddress("how to rebase")).toBe("https://www.google.com/search?q=how%20to%20rebase");
  expect(toAddress("   ")).toBeNull();
});

it("never loads non-http schemes", () => {
  for (const input of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "tauri://localhost"]) {
    expect(toAddress(input)?.startsWith("https://www.google.com/search?q=")).toBe(true);
  }
});
