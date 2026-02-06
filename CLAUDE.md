## 开发规范与日志自动化

- **实时变更记录**：每次调用文件修改工具（如 `replace_lines` 或 `write_to_file`）并确认成功后，必须立即在 `LOG.md` 末尾追加记录。
  - 格式：`[日期] 动作: 简述原因 (涉及文件)`
- **技术决策归档**：每当我输入 `## DONE` 时，请执行以下操作：
  1. 总结当前 Session 的核心技术决策（如架构调整、选型原因、解决的疑难 Bug）。
  2. 将总结内容追加到 `DEVELOPMENT_NOTES.md`。
  3. 完成后，提醒我是否需要执行 `/compact` 或 `/clear` 以节省后续成本。

## 技术限制与避坑指南 (Known Constraints)

- **Chrome Extension (V3)**:
  - `background.js` (Service Worker) 运行环境限制：
    - **禁止使用 `URL` 对象的相关方法**：例如 `URL.createObjectURL()` 在此环境下不存在，会抛出错误。
    - **替代方案**：如果需要处理文件，请将数据转换为 Base64 格式传输，或者在 Offscreen Document / Side Panel 中处理 Blob。