import express, { Request, Response } from "express";
import cors from "cors";
import axios from "axios";
import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import * as promClient from "prom-client";

dotenv.config();

const prisma = new PrismaClient();
const app = express();

// CORS
app.use(
  cors({
    origin: [
      process.env.CORS_ORIGIN || "http://localhost:5173",
      /\.vercel\.app$/,
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.use(express.json());

const PORT = parseInt(process.env.PORT || "10000", 10);
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

// ========================================
// MÉTRICAS DE PROMETHEUS
// ========================================
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register, prefix: "mcp_taller_" });

const anomalyGauge = new promClient.Gauge({
  name: "mcp_taller_business_anomaly",
  help: "Indica anomalías detectadas: 0=Normal, 1=Potencial, 2=Crítica",
  labelNames: ["type"],
});
register.registerMetric(anomalyGauge);

const analysisCounter = new promClient.Counter({
  name: "mcp_taller_analysis_total",
  help: "Total de análisis realizados",
  labelNames: ["status"],
});
register.registerMetric(analysisCounter);

// ========================================
// FUNCIÓN: OBTENER MÉTRICAS DEL NEGOCIO
// ========================================
async function getBusinessMetrics() {
  try {
    const [
      pendingOrders,
      inProgressOrders,
      completedOrders,
      totalClients,
      totalVehicles,
      todayRevenue,
      activeEmployees,
      activeServices,
    ] = await Promise.all([
      prisma.ordenes_servicio.count({ where: { estado: "pendiente" } }),
      prisma.ordenes_servicio.count({ where: { estado: "en_proceso" } }),
      prisma.ordenes_servicio.count({ where: { estado: "completado" } }),
      prisma.clientes.count(),
      prisma.vehiculos.count(),
      prisma.facturas.aggregate({
        where: {
          fecha: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        _sum: { total: true },
      }),
      prisma.empleados.count({ where: { activo: true } }),
      prisma.servicios.count({ where: { activo: true } }),
    ]);

    return {
      ordenes_pendientes: pendingOrders,
      ordenes_en_proceso: inProgressOrders,
      ordenes_completadas: completedOrders,
      total_clientes: totalClients,
      total_vehiculos: totalVehicles,
      ingresos_hoy: Number(todayRevenue._sum.total || 0),
      empleados_activos: activeEmployees,
      servicios_activos: activeServices,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Error obteniendo métricas del negocio:", error);
    throw error;
  }
}

// ========================================
// FUNCIÓN: OBTENER MÉTRICAS DEL SISTEMA
// ========================================
async function getSystemMetrics() {
  try {
    const queries = {
      cpu: '(1 - avg(irate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100',
      memory:
        "node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100",
      disk: '100 - ((node_filesystem_avail_bytes{mountpoint="/"} * 100) / node_filesystem_size_bytes{mountpoint="/"})',
    };

    const [cpuRes, memRes, diskRes] = await Promise.all([
      axios
        .get(`${PROMETHEUS_URL}/api/v1/query`, {
          params: { query: queries.cpu },
        })
        .catch(() => null),
      axios
        .get(`${PROMETHEUS_URL}/api/v1/query`, {
          params: { query: queries.memory },
        })
        .catch(() => null),
      axios
        .get(`${PROMETHEUS_URL}/api/v1/query`, {
          params: { query: queries.disk },
        })
        .catch(() => null),
    ]);

    const extractValue = (res: any) => {
      try {
        return res?.data?.data?.result?.[0]?.value?.[1] || null;
      } catch {
        return null;
      }
    };

    return {
      cpu_usage: extractValue(cpuRes),
      memory_available: extractValue(memRes),
      disk_usage: extractValue(diskRes),
    };
  } catch (error) {
    console.error("Error obteniendo métricas del sistema:", error);
    return { cpu_usage: null, memory_available: null, disk_usage: null };
  }
}

// ========================================
// FUNCIÓN: ANALIZAR CON GROQ AI
// ========================================
async function analyzeWithGroq(businessMetrics: any, systemMetrics: any) {
  if (!GROQ_API_KEY) {
    return {
      anomaly: "No",
      type: "N/A",
      justification: "API Key de Groq no configurada",
      recommendation: "Configurar GROQ_API_KEY en .env",
      priority: "N/A",
    };
  }

  const prompt = `
Eres un consultor experto en gestión de talleres mecánicos y análisis operacional.

Analiza las siguientes métricas del negocio y del sistema:

**MÉTRICAS DE NEGOCIO:**
- Órdenes pendientes: ${businessMetrics.ordenes_pendientes}
- Órdenes en proceso: ${businessMetrics.ordenes_en_proceso}
- Órdenes completadas hoy: ${businessMetrics.ordenes_completadas}
- Total de clientes: ${businessMetrics.total_clientes}
- Total de vehículos: ${businessMetrics.total_vehiculos}
- Ingresos del día: $${businessMetrics.ingresos_hoy.toFixed(2)}
- Empleados activos: ${businessMetrics.empleados_activos}
- Servicios activos: ${businessMetrics.servicios_activos}

**MÉTRICAS DEL SISTEMA:**
- Uso de CPU: ${
    systemMetrics.cpu_usage
      ? parseFloat(systemMetrics.cpu_usage).toFixed(2) + "%"
      : "N/A"
  }
- Memoria disponible: ${
    systemMetrics.memory_available
      ? parseFloat(systemMetrics.memory_available).toFixed(2) + "%"
      : "N/A"
  }
- Uso de disco: ${
    systemMetrics.disk_usage
      ? parseFloat(systemMetrics.disk_usage).toFixed(2) + "%"
      : "N/A"
  }

Detecta posibles anomalías o problemas operacionales y responde EXACTAMENTE en este formato:

**Anomalía Detectada:** [Sí/No/Potencial]
**Tipo:** [Operacional/Recursos/Negocio/Sistema]
**Justificación:** [Explicación concisa en máximo 100 palabras]
**Recomendación:** [Acción específica a tomar]
**Prioridad:** [Alta/Media/Baja]
`;

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const analysis = response.data?.choices?.[0]?.message?.content || "";

    // Extraer información del análisis
    const extractField = (field: string): string => {
      const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+?)(?=\\n|$)`, "i");
      const match = analysis.match(regex);
      return match ? match[1].trim() : "N/A";
    };

    return {
      anomaly: extractField("Anomalía Detectada"),
      type: extractField("Tipo"),
      justification: extractField("Justificación"),
      recommendation: extractField("Recomendación"),
      priority: extractField("Prioridad"),
      fullAnalysis: analysis,
    };
  } catch (error) {
    console.error("Error en análisis con Groq:", error);
    return {
      anomaly: "Error",
      type: "Sistema",
      justification: "Error al comunicarse con Groq AI",
      recommendation: "Verificar API Key y conexión",
      priority: "Media",
    };
  }
}

// ========================================
// ENDPOINT: ANÁLISIS COMPLETO
// ========================================
app.get("/aiops/check-business", async (req: Request, res: Response) => {
  try {
    console.log("🔍 Iniciando análisis AIOps...");

    // 1. Obtener métricas
    const businessMetrics = await getBusinessMetrics();
    const systemMetrics = await getSystemMetrics();

    // 2. Analizar con IA
    const aiAnalysis = await analyzeWithGroq(businessMetrics, systemMetrics);

    // 3. Actualizar métricas de Prometheus
    const anomalyLevel = aiAnalysis.anomaly.toLowerCase().includes("sí")
      ? 2
      : aiAnalysis.anomaly.toLowerCase().includes("potencial")
      ? 1
      : 0;

    anomalyGauge.set({ type: aiAnalysis.type }, anomalyLevel);
    analysisCounter.inc({ status: "success" });

    // 4. Responder
    res.json({
      timestamp: new Date().toISOString(),
      status: "success",
      businessMetrics,
      systemMetrics: {
        cpu_usage: systemMetrics.cpu_usage
          ? `${parseFloat(systemMetrics.cpu_usage).toFixed(2)}%`
          : "N/A",
        memory_available: systemMetrics.memory_available
          ? `${parseFloat(systemMetrics.memory_available).toFixed(2)}%`
          : "N/A",
        disk_usage: systemMetrics.disk_usage
          ? `${parseFloat(systemMetrics.disk_usage).toFixed(2)}%`
          : "N/A",
      },
      aiAnalysis: {
        anomalyDetected: aiAnalysis.anomaly,
        type: aiAnalysis.type,
        priority: aiAnalysis.priority,
        justification: aiAnalysis.justification,
        recommendation: aiAnalysis.recommendation,
      },
      anomalyLevel:
        anomalyLevel === 2
          ? "CRÍTICA"
          : anomalyLevel === 1
          ? "POTENCIAL"
          : "NORMAL",
    });

    console.log("✅ Análisis completado");
  } catch (error) {
    console.error("❌ Error en análisis:", error);
    analysisCounter.inc({ status: "error" });
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: "error",
      error: "Error en el análisis AIOps",
      message: error instanceof Error ? error.message : "Error desconocido",
    });
  }
});

// ========================================
// ENDPOINT: MÉTRICAS PROMETHEUS
// ========================================
app.get("/metrics", async (req: Request, res: Response) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// ========================================
// ENDPOINT: HEALTH CHECK
// ========================================
app.get("/health", async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: "connected",
        prometheus: PROMETHEUS_URL,
        groq: GROQ_API_KEY ? "configured" : "not configured",
      },
      uptime: process.uptime(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: "Database connection failed",
    });
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================
app.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(60));
  console.log("🤖 MCP-AIOps para Taller Mecánico");
  console.log("=".repeat(60));
  console.log(`✅ Servidor iniciado en puerto ${PORT}`);
  console.log(`📊 Métricas: http://localhost:${PORT}/metrics`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`🔍 Análisis: http://localhost:${PORT}/aiops/check-business`);
  console.log("=".repeat(60));

  if (!GROQ_API_KEY) {
    console.warn("⚠️  ADVERTENCIA: GROQ_API_KEY no configurada");
    console.warn("   El análisis con IA estará deshabilitado");
  }
});
