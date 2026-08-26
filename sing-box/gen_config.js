// $arguments.template 模板文件名
// 文件内容 inbounds 数组

const inbounds = JSON.parse($content);
const template = $arguments.template;
console.log("[gen_config] use template file: " + template);

async function genConfig(inbounds, template) {
  const tplContent = JSON.parse(
    await produceArtifact({
      type: "file",
      name: template,
    }),
  );

  let outContent = tplContent;
  if (!outContent.inbounds) {
    outContent.inbounds = [];
  }
  outContent.inbounds.push(...inbounds);

  return outContent;
}

try {
  $content = JSON.stringify(await genConfig(inbounds, template), null, 2);
} catch (error) {
  $content = $content;
}
