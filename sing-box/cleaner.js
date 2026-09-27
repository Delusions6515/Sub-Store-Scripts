// 放置于脚本操作最顶端

async function operator() {
  scriptResourceCache._cleanup('sb-artifact:', 30 * 60 * 1000) // 30 分钟
  scriptResourceCache._cleanup('xhttp-node:', 30 * 60 * 1000) // 30 分钟
}