import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "npm:@modelcontextprotocol/sdk/server/sse.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    CallToolRequest,
    CallToolResult,
    Tool,
} from "npm:@modelcontextprotocol/sdk/types.js";
import express from "npm:express";
import { v4 as uuidv4 } from "npm:uuid"; 

// ==================== 类型定义 ====================

/**
 * 工具处理器接口
 * 将工具定义和处理逻辑绑定在一起
 */
interface ToolHandler {
    tool: Tool;
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

// ==================== 辅助函数 ====================

/**
 * 创建文本响应
 * @param text 响应文本
 * @param isError 是否为错误响应
 */
function createTextResponse(text: string, isError = false): CallToolResult {
    return {
        content: [{ type: "text", text }],
        isError,
    };
}

// ==================== 工具注册系统 ====================

/**
 * 工具注册表
 * 管理所有可用工具及其处理逻辑
 */
class ToolRegistry {
    private tools: Map<string, ToolHandler> = new Map();

    /**
     * 注册单个工具
     */
    register(toolHandler: ToolHandler): void {
        this.tools.set(toolHandler.tool.name, toolHandler);
    }

    /**
     * 批量注册工具
     */
    registerAll(toolHandlers: ToolHandler[]): void {
        for (const handler of toolHandlers) {
            this.register(handler);
        }
    }

    /**
     * 获取所有已注册工具的定义
     */
    getTools(): Tool[] {
        return Array.from(this.tools.values()).map(th => th.tool);
    }

    /**
     * 处理工具调用请求
     */
    async handleToolCall(
        name: string,
        args: Record<string, unknown>
    ): Promise<CallToolResult> {
        const toolHandler = this.tools.get(name);
        if (!toolHandler) return createTextResponse(`未知工具: ${name}`, true);

        try {
            return await toolHandler.handler(args);
        } catch (error: unknown) {
            return createTextResponse(`工具执行错误: ${error instanceof Error ? error.message : String(error)}`, true);
        }
    }
}

// ==================== 工具实现 ====================

/**
 * 可用工具集合
 */
const TOOLS: ToolHandler[] = [
    // 网页元标签信息获取
    {
        tool: {
            name: "fetchMetaTags",
            description: "获取指定网页的元标签(meta)信息，如标题、描述、favicon、OpenGraph、Twitter等。",
            inputSchema: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "要提取元信息的网址（完整URL），如 https://example.com"
                    },
                    meta: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "（可选）要获取的特定元标签名数组，如 [\"language\",\"charset\",\"viewport\",\"title\",\"description\",\"keywords\",\"favicon\",\"author\",\"generator\",\"theme\",\"canonical\",\"ogUrl\",\"ogTitle\",\"ogSiteName\",\"ogDescription\",\"ogImage\",\"ogImageAlt\",\"ogType\",\"twitterSite\",\"twitterCard\",\"twitterTitle\",\"twitterCreator\",\"twitterDescription\",\"twitterImage\",\"robots\",\"icons]，不填则返回所有支持的元标签"
                    }
                },
                required: ["url"]
            }
        },
        handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
            const url = args.url as string;
            const meta = Array.isArray(args.meta) ? (args.meta as string[]) : undefined;

            if (typeof url !== "string" || !/^https?:\/\/.+/i.test(url)) {
                return createTextResponse("请提供有效的网址（必须以 http:// 或 https:// 开头）", true);
            }

            try {
                const params = new URLSearchParams({ url });
                if (meta && meta.length > 0) {
                    params.set("meta", meta.join(","));
                }

                const apiUrl = `https://meta-thief.itea.dev/api/meta?${params.toString()}`;

                const response = await fetch(apiUrl, {
                    method: "GET"
                });

                if (!response.ok) {
                    return createTextResponse(`MetaThief API 请求失败，状态码: ${response.status}`, true);
                }

                const data = await response.json();

                if ("error" in data) {
                    return createTextResponse(
                        `MetaThief API 错误: ${data.error || ""}${data.message ? " - " + data.message : ""}`,
                        true
                    );
                }

                return createTextResponse(JSON.stringify(data, null, 2));
            } catch (error) {
                return createTextResponse(
                    `获取网页元标签信息时发生错误: ${error instanceof Error ? error.message : String(error)}`,
                    true
                );
            }
        }
    },
    // ReadPo Markdown 海报
    {
        tool: {
            name: "readpoPoster",
            description: "将传入的 Markdown 内容渲染为海报图片，返回图片直链（使用 https://readpo.com/p/Markdown内容 作为图片链接）。",
            inputSchema: {
                type: "object",
                properties: {
                    markdown: {
                        type: "string",
                        description: "要渲染为海报的 Markdown 内容"
                    }
                },
                required: ["markdown"]
            }
        },
        handler: async (args: Record<string, unknown>): Promise<CallToolResult> => {
            const markdown = args.markdown as string;
            if (typeof markdown !== "string" || markdown.trim() === "") {
                return createTextResponse("请提供要渲染为海报的 Markdown 内容", true);
            }
            // 直接拼接链接，encodeURIComponent 以防止内容包含特殊字符
            const imageUrl = `https://readpo.com/p/${encodeURIComponent(markdown)}`;
            return createTextResponse(imageUrl);
        }
    },
];

// ==================== 服务器配置 ====================

/**
 * 创建并配置服务器
 * @returns 服务器实例和清理函数
 */
function createServer(): { server: Server; cleanup: () => Promise<void> } {
    // 创建注册表实例
    const toolRegistry = new ToolRegistry();

    // 注册工具
    toolRegistry.registerAll(TOOLS);

    // 创建服务器
    const server = new Server(
        {
            name: "工具服务器",
            version: "1.0.0",
            description: "模块化工具服务器，提供各种实用工具功能"
        },
        {
            capabilities: {
                tools: {
                    list: true,
                    call: true
                },
            },
        }
    );

    // 设置工具请求处理程序
    server.setRequestHandler(ListToolsRequestSchema, () => {
        return { tools: toolRegistry.getTools() };
    });

    // 设置工具调用处理程序
    server.setRequestHandler(CallToolRequestSchema, (request: CallToolRequest) => {
        return toolRegistry.handleToolCall(request.params.name, request.params.arguments ?? {});
    });

    // 清理函数
    const cleanup = async (): Promise<void> => {
        // 执行必要的清理操作
        console.error("正在清理资源...");
    };

    return { server, cleanup };
}

// ==================== 主程序 ====================

/**
 * 主程序入口
 */
async function main() {
    const { server, cleanup } = createServer();
    const app = express();
    const activeTransports = new Map();
    let transport: SSEServerTransport;

    // 添加根路由，返回使用说明页面
    app.get("/", (req, res) => {
        // 获取主机信息，如果没有则默认使用 localhost
        const host = req.headers.host || `localhost:${PORT}`;
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        // 从 TOOLS 数组生成工具 HTML
        const toolsHtml = TOOLS.map(toolHandler => {
            const { name, description } = toolHandler.tool;

            return `
                <div class="tool-card">
                <h3 class="tool-title">${name}</h3>
                <p class="tool-description">${description}</p>
                </div>
      `;
        }).join('');

        const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MCPie - 强大的 MCP 工具服务器</title>
        <style>
            * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            }

            body {
            font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
            line-height: 1.6;
            color: #2c3e50;
            background: #f8fbff;
            min-height: 100vh;
            }

            .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 20px;
            }

            /* Header */
            .header {
            background: transparent;
            padding: 20px 0;
            z-index: 100;
            }

            .nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            }

            .logo {
            font-size: 2rem;
            font-weight: 700;
            color: #42a5f5;
            }

            .nav-links {
            display: flex;
            gap: 30px;
            }

            .nav-links a {
            text-decoration: none;
            color: #2c3e50;
            font-weight: 500;
            transition: color 0.3s ease;
            }

            .nav-links a:hover {
            color: #42a5f5;
            }

            /* Hero Section */
            .hero {
            padding: 100px 0;
            text-align: center;
            background: rgba(227, 242, 253, 0.3);
            border-radius: 20px;
            margin: 40px 0;
            }

            .hero-title {
            font-size: 3.5rem;
            font-weight: 700;
            margin-bottom: 20px;
            color: #1565c0;
            }

            .hero-subtitle {
            font-size: 1.3rem;
            color: #546e7a;
            margin-bottom: 40px;
            max-width: 600px;
            margin-left: auto;
            margin-right: auto;
            }

            .cta-button {
            display: inline-block;
            background: #42a5f5;
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            text-decoration: none;
            font-weight: 600;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            box-shadow: 0 4px 15px rgba(66, 165, 245, 0.3);
            }

            .cta-button:hover {
            transform: translateY(-2px);
            background: #1e88e5;
            box-shadow: 0 8px 25px rgba(66, 165, 245, 0.4);
            }

            /* Features Section */
            .features {
            padding: 80px 0;
            }

            .section-title {
            text-align: center;
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 60px;
            color: #1565c0;
            }

            .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin-bottom: 60px;
            }

            .feature-card {
            background: rgba(255, 255, 255, 0.9);
            padding: 30px;
            border-radius: 20px;
            text-align: center;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid rgba(66, 165, 245, 0.1);
            backdrop-filter: blur(10px);
            }

            .feature-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 35px rgba(66, 165, 245, 0.2);
            }

            .feature-icon {
            width: 60px;
            height: 60px;
            margin: 0 auto 20px;
            background: #42a5f5;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: white;
            }

            .feature-title {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 15px;
            color: #1565c0;
            }

            .feature-description {
            color: #546e7a;
            line-height: 1.6;
            }

            /* Connection Section */
            .connection {
            background: rgba(255, 255, 255, 0.9);
            padding: 60px 0;
            border-radius: 20px;
            margin: 40px 0;
            }

            .connection-content {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 50px;
            align-items: center;
            }

            .connection-steps {
            list-style: none;
            counter-reset: step-counter;
            }

            .connection-steps li {
            counter-increment: step-counter;
            margin-bottom: 20px;
            padding-left: 60px;
            position: relative;
            }

            .connection-steps li::before {
            content: counter(step-counter);
            position: absolute;
            left: 0;
            top: 0;
            width: 40px;
            height: 40px;
            background: #ec407a;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            }

            .endpoint-info {
            background: rgba(227, 242, 253, 0.5);
            padding: 30px;
            border-radius: 15px;
            border-left: 4px solid #42a5f5;
            }

            .endpoint-info h3 {
            color: #1565c0;
            margin-bottom: 15px;
            }

            /* Tools Section */
            .tools {
            padding: 80px 0;
            }

            .tools-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            max-width: 1000px;
            margin: 0 auto;
            }

            .tool-card {
            background: white;
            padding: 30px;
            border-radius: 15px;
            text-align: center;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border: 1px solid #e0e0e0;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
            }

            .tool-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
            }

            .tool-icon {
            width: 50px;
            height: 50px;
            margin: 0 auto 15px;
            background: #f5f5f5;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            }

            .tool-title {
            font-size: 1.2rem;
            font-weight: 600;
            margin-bottom: 10px;
            color: #1565c0;
            }

            .tool-description {
            color: #666;
            font-size: 0.9rem;
            line-height: 1.4;
            }

            /* Usage Section */
            .usage {
            background: rgba(255, 255, 255, 0.9);
            padding: 60px 0;
            border-radius: 20px;
            margin: 40px 0;
            }

            .usage-examples {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
            gap: 30px;
            margin-top: 40px;
            }

            .usage-card {
            background: rgba(252, 228, 236, 0.3);
            padding: 25px;
            border-radius: 15px;
            border: 1px solid rgba(236, 64, 122, 0.2);
            }

            .usage-card h4 {
            color: #1565c0;
            margin-bottom: 10px;
            }

            .usage-card code {
            background: #f8f9fa;
            padding: 10px 15px;
            border-radius: 8px;
            display: block;
            font-family: 'Courier New', monospace;
            color: #2c3e50;
            border-left: 3px solid #ec407a;
            }

            /* Footer */
            .footer {
            background: rgba(255, 255, 255, 0.95);
            padding: 40px 0;
            margin-top: 80px;
            text-align: center;
            border-top: 1px solid rgba(66, 165, 245, 0.1);
            }

            .footer p {
            color: #546e7a;
            }

            /* Responsive Design */
            @media (max-width: 768px) {
            .hero-title {
                font-size: 2.5rem;
            }

            .connection-content {
                grid-template-columns: 1fr;
            }

            .nav-links {
                display: none;
            }

            .features-grid {
                grid-template-columns: 1fr;
            }

            .usage-examples {
                grid-template-columns: 1fr;
            }
            }

            /* Animations */
            @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
            }

            .feature-card {
            animation: fadeInUp 0.6s ease-out;
            }

            .feature-card:nth-child(1) { animation-delay: 0.1s; }
            .feature-card:nth-child(2) { animation-delay: 0.2s; }
            .feature-card:nth-child(3) { animation-delay: 0.3s; }
            .feature-card:nth-child(4) { animation-delay: 0.4s; }
        </style>
        </head>
        <body>
        <header class="header">
            <div class="container">
            <nav class="nav">
                <div class="logo">MCPie</div>
                <div class="nav-links">
                <a href="#features">功能</a>
                <a href="#connection">连接</a>
                <a href="#tools">工具</a>
                <a href="#usage">使用</a>
                </div>
            </nav>
            </div>
        </header>

        <main class="container">
            <section class="hero">
            <h1 class="hero-title">MCPie</h1>
            <p class="hero-subtitle">基于 Model Context Protocol (MCP) 的强大工具服务器，为您提供多种实用工具功能，让 AI 助手更加强大。</p>
            <a href="#connection" class="cta-button">立即开始</a>
            </section>

            <section id="features" class="features">
            <h2 class="section-title">核心功能</h2>
            <div class="features-grid">
                <div class="feature-card">
                <div class="feature-icon">🔧</div>
                <h3 class="feature-title">多工具集成</h3>
                <p class="feature-description">集成多种实用工具，满足不同场景下的需求，提升工作效率。</p>
                </div>
                <div class="feature-card">
                <div class="feature-icon">⚡</div>
                <h3 class="feature-title">高性能</h3>
                <p class="feature-description">基于现代化架构设计，响应速度快，处理能力强。</p>
                </div>
                <div class="feature-card">
                <div class="feature-icon">🔗</div>
                <h3 class="feature-title">易于集成</h3>
                <p class="feature-description">完全兼容 MCP 协议，可轻松集成到 Cursor 等 AI 工具中。</p>
                </div>
            </div>
            </section>

            <section id="connection" class="connection">
            <div class="container">
                <h2 class="section-title">如何连接</h2>
                <div class="connection-content">
                <div>
                    <h3 style="margin-bottom: 20px;">在 Cursor 中连接步骤：</h3>
                    <ol class="connection-steps">
                    <li>打开 Cursor 设置</li>
                    <li>导航到 MCP Servers 部分</li>
                    <li>点击 "Add new MCP server"</li>
                    <li>输入服务器信息并保存</li>
                    </ol>
                </div>
                <div class="endpoint-info">
                    <h3>服务器端点</h3>
                    <p><strong>SSE 端点:</strong> <code>${baseUrl}/sse</code></p>
                    <p><strong>消息端点:</strong> <code>${baseUrl}/message</code></p>
                </div>
                </div>
            </div>
            </section>

            <section id="tools" class="tools">
            <h2 class="section-title">可用工具</h2>
            <div class="tools-grid">
                ${toolsHtml}
            </div>
            </section>

            <section id="usage" class="usage">
            <div class="container">
                <h2 class="section-title">使用示例</h2>
                <p style="text-align: center; color: #546e7a; margin-bottom: 30px;">连接到服务器后，您可以在 Cursor 中使用这些工具（工具名会自动加上 mcp__ 前缀）</p>
                <div class="usage-examples">
                <div class="usage-card">
                    <h4>查看可用工具</h4>
                    <code style="background: white;">你可以使用哪些 mcp 工具</code>
                </div>
                <div class="usage-card">
                    <h4>验证工具功能</h4>
                    <code style="background: white;">请帮我验证下 mcp__XXX 工具</code>
                </div>
                </div>
            </div>
            </section>
        </main>

        <footer class="footer">
            <div class="container">
            <p>&copy; 2024 MCPie. 基于 Model Context Protocol 构建。</p>
            </div>
        </footer>

        <script>
            // 平滑滚动
            document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                target.scrollIntoView({
                    behavior: 'smooth'
                });
                }
            });
            });
        </script>
        </body>
        </html>
    `;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    });

    app.get("/sse", async (req, res) => {
        const connectionId = uuidv4();
        transport = new SSEServerTransport(`/message/${connectionId}`, res);
        await server.connect(transport);
         activeTransports.set(connectionId, transport);

        server.onclose = async () => {
            activeTransports.delete(connectionId);
            await cleanup();
            await server.close();
            process.exit(0);
        };
    });

    app.post("/message/:connectionId", async (req, res) => {
        const connectionId = req.params.connectionId;
        const transport = activeTransports.get(connectionId);

        if (!transport) {
            return res.status(404).send("Connection not found");
        }
        try {
            await transport.handlePostMessage(req, res);
        } catch (error) {
            console.error("Error handling message:", error);
            res.status(500).send("Internal server error");
        }
    });

    const PORT = Deno.env.get("PORT") || 3001;
    app.listen(Number(PORT));
}

// 启动服务器
await main();