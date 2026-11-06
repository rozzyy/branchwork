import { syncNativeTheme } from "./native";

it("is a no-op outside Tauri", async () => {
  await expect(syncNativeTheme("dark")).resolves.toBeUndefined();
});
