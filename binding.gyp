{
  "targets": [
    {
      "target_name": "bw_reseed",
      "sources": ["native/reseed.c"],
      "include_dirs": ["<(node_root_dir)/deps/openssl/openssl/include"],
      "conditions": [
        ["OS=='linux'", { "cflags": ["-fvisibility=hidden"] }]
      ]
    }
  ]
}
