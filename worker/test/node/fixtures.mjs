// The fixed strings the Go build sealed into fixtures/, and their passphrases.

export const fixtures = [
  {
    file: "go-sealed.ziwo-export",
    plain: "fixture line one, plainmark5k\n固定的第二行 plainmark5k\n".repeat(20),
    pass: "fixture passphrase 12",
  },
  { file: "go-sealed-empty.ziwo-export", plain: "", pass: "fixture passphrase 12" },
  // Twelve bytes in four characters: Go counts the passphrase in bytes.
  { file: "go-sealed-cjk-pass.ziwo-export", plain: "{\"short\":true}\n", pass: "记忆口令" },
];
