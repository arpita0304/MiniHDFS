# MiniHDFS - Distributed File Storage Simulator

Split files into blocks, replicate them across logical storage nodes, simulate node failures,
reconstruct files and verify them with SHA-256.

## Run
Requires Node 18+ and MongoDB running locally (`mongodb://127.0.0.1:27017`).

    cd server && npm install && npm start      # API on :5000
    cd client && npm install && npm run dev    # UI on :5173

## Structure
- server/index.js      Express API: chunking, replication, reconstruction, integrity, monitoring
- server/storage/      node1..node4 folders (created on boot) = simulated DataNodes
- client/src/App.jsx   Dashboard, Upload, Files/Block explorer, Nodes & monitoring

## Phase 4 (real HDFS)
Replace `writeBlock` / `readBlock` in server/index.js with WebHDFS calls
(PUT/GET http://namenode:9870/webhdfs/v1/minihdfs/<blockId>?op=CREATE|OPEN).
