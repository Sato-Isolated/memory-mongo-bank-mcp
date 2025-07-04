import { MongoClient, Db, Collection } from "mongodb";
import { FileRepository } from "../../../data/protocols/file-repository.js";
import { ProjectRepository } from "../../../data/protocols/project-repository.js";
import { FileVersionRepository } from "../../../data/protocols/file-version-repository.js";
import { File, FileSchema } from "../../../domain/entities/file.js";
import {
  StorageError,
  ValidationError,
} from "../../../presentation/errors/enhanced-errors.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

interface MongoFileDocument {
  _id?: any;
  id: string;
  name: string;
  content: string;
  projectName: string;
  createdAt: Date;
  updatedAt: Date;
  size: number;
  checksum?: string;
  metadata: {
    encoding: string;
    mimeType: string;
    tags?: string[];
    wordCount?: number;
    lineCount?: number;
    keywords?: string[];
    summary?: string;
    version?: number;
  };
}

export class MongoFileRepository implements FileRepository {
  private db: Db;
  private collection: Collection<MongoFileDocument>;
  private projectRepository: ProjectRepository;
  private fileVersionRepository?: FileVersionRepository;

  constructor(
    client: MongoClient,
    dbName: string,
    projectRepository?: ProjectRepository,
    fileVersionRepository?: FileVersionRepository
  ) {
    this.db = client.db(dbName);
    this.collection = this.db.collection<MongoFileDocument>("memory_files");
    // Pour la compatibilité, on peut optionnellement accepter un ProjectRepository
    // Si non fourni, on crée une instance temporaire (ce qui sera géré par le factory)
    this.projectRepository = projectRepository!;
    this.fileVersionRepository = fileVersionRepository;
    this.ensureIndexes();
  }
  private async ensureIndexes(): Promise<void> {
    try {
      // Helper function to create an index safely
      const createIndexSafely = async (keys: any, options: any) => {
        try {
          await this.collection.createIndex(keys, options);
          console.log(`✅ Created index: ${options.name || "unnamed"}`);
        } catch (error: any) {
          if (error.code === 86 || error.codeName === "IndexKeySpecsConflict") {
            try {
              const indexName = options.name || Object.keys(keys).join("_");
              console.warn(
                `⚠️ Index conflict for ${indexName}, attempting to recreate...`
              );
              await this.collection.dropIndex(indexName);
              await this.collection.createIndex(keys, options);
              console.log(`✅ Successfully recreated index: ${indexName}`);
            } catch (recreateError) {
              console.warn(`⚠️ Could not recreate index:`, recreateError);
            }
          } else {
            console.warn(`⚠️ Failed to create index:`, error.message);
          }
        }
      };

      // Create all indexes with explicit names
      await createIndexSafely(
        { projectName: 1, name: 1 },
        { unique: true, name: "project_name_unique_idx" }
      );

      await createIndexSafely(
        { projectName: 1, updatedAt: -1 },
        { name: "project_updated_idx" }
      );

      await createIndexSafely({ checksum: 1 }, { name: "file_checksum_idx" });

      await createIndexSafely(
        { "metadata.mimeType": 1 },
        { name: "mime_type_idx" }
      );

      await createIndexSafely({ size: 1 }, { name: "file_size_idx" });

      await createIndexSafely({ "metadata.tags": 1 }, { name: "tags_idx" });

      // Create text search index
      await createIndexSafely(
        {
          content: "text",
          name: "text",
          "metadata.tags": "text",
          "metadata.keywords": "text",
        },
        {
          name: "content_search_index",
          weights: {
            name: 10,
            "metadata.tags": 5,
            "metadata.keywords": 8,
            content: 1,
          },
        }
      );

      console.log("✅ MongoDB indexes setup completed");
    } catch (error) {
      console.warn("⚠️ Failed to setup MongoDB indexes:", error);
    }
  }
  private enhanceFileMetadata(
    content: string,
    fileName: string,
    currentVersion?: number
  ): MongoFileDocument["metadata"] {
    const lines = content.split("\n");
    const words = content.split(/\s+/).filter((word) => word.length > 0);

    // Extraction de mots-clés simples (mots de plus de 4 caractères)
    const keywords = [
      ...new Set(
        words
          .filter((word) => word.length > 4 && /^[a-zA-Z]+$/.test(word))
          .map((word) => word.toLowerCase())
      ),
    ].slice(0, 20);

    // Génération d'un résumé simple (premières lignes non vides)
    const summary = lines
      .filter((line) => line.trim().length > 0)
      .slice(0, 3)
      .join(" ")
      .substring(0, 200);

    return {
      encoding: "utf-8",
      mimeType: fileName.endsWith(".md") ? "text/markdown" : "text/plain",
      wordCount: words.length,
      lineCount: lines.length,
      keywords,
      summary: summary || undefined,
      version: currentVersion || 1,
    };
  }
  private mongoDocumentToFile(doc: MongoFileDocument): File {
    return FileSchema.parse({
      id: doc.id,
      name: doc.name,
      content: doc.content,
      projectName: doc.projectName,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      size: doc.size,
      checksum: doc.checksum,
      metadata: {
        encoding: doc.metadata.encoding,
        mimeType: doc.metadata.mimeType,
        tags: doc.metadata.tags,
        wordCount: doc.metadata.wordCount,
        lineCount: doc.metadata.lineCount,
        keywords: doc.metadata.keywords,
        summary: doc.metadata.summary,
        version: doc.metadata.version,
      },
    });
  }
  async listFiles(projectName: string): Promise<File[]> {
    try {
      const files = await this.collection
        .find({ projectName })
        .sort({ updatedAt: -1 })
        .toArray();

      return files.map((file) => this.mongoDocumentToFile(file));
    } catch (error) {
      throw new StorageError(
        `Failed to list files for project ${projectName}`,
        error as Error
      );
    }
  }
  async loadFile(projectName: string, fileName: string): Promise<File | null> {
    try {
      const file = await this.collection.findOne({
        projectName,
        name: fileName,
      });

      return file ? this.mongoDocumentToFile(file) : null;
    } catch (error) {
      throw new StorageError(
        `Failed to load file ${fileName} from project ${projectName}`,
        error as Error
      );
    }
  }
  async writeFile(
    projectName: string,
    fileName: string,
    content: string
  ): Promise<File | null> {
    try {
      const now = new Date();
      const contentBuffer = Buffer.from(content, "utf8");
      const checksum = createHash("sha256").update(contentBuffer).digest("hex");

      const mongoDoc: MongoFileDocument = {
        id: randomUUID(),
        name: fileName,
        content,
        projectName,
        createdAt: now,
        updatedAt: now,
        size: contentBuffer.length,
        checksum,
        metadata: this.enhanceFileMetadata(content, fileName),
      };
      // Validate with Zod before inserting
      const validatedFile = this.mongoDocumentToFile(mongoDoc);

      await this.collection.insertOne(mongoDoc);

      // Mettre à jour les statistiques du projet
      await this.updateProjectStats(projectName);

      return validatedFile;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError(error.issues);
      }
      throw new StorageError(
        `Failed to write file ${fileName} to project ${projectName}`,
        error as Error
      );
    }
  }  async updateFile(
    projectName: string,
    fileName: string,
    content: string
  ): Promise<File | null> {
    try {
      const now = new Date();
      const contentBuffer = Buffer.from(content, "utf8");
      const checksum = createHash("sha256").update(contentBuffer).digest("hex");

      // Get current file to create version before update
      const currentFile = await this.collection.findOne({
        projectName,
        name: fileName,
      });

      if (!currentFile) {
        return null;
      }

      // Create version history if versioning is enabled
      if (this.fileVersionRepository) {
        try {
          await this.fileVersionRepository.createVersion({
            fileId: currentFile.id,
            projectName: currentFile.projectName,
            fileName: currentFile.name,
            content: currentFile.content,
            version: currentFile.metadata?.version || 1,
            checksum: currentFile.checksum || "",
            size: currentFile.size,
            createdAt: currentFile.updatedAt,
            metadata: {
              ...currentFile.metadata,
              changeDescription: "Updated via API",
              isAutoSave: false,
            },
          });
        } catch (versionError) {
          console.warn(`Failed to create version for ${fileName}:`, versionError);
        }
      }

      // Increment version number
      const newVersion = (currentFile.metadata?.version || 1) + 1;

      const updateData = {
        content,
        updatedAt: now,
        size: contentBuffer.length,
        checksum,
        metadata: this.enhanceFileMetadata(content, fileName, newVersion),
      };

      const result = await this.collection.findOneAndUpdate(
        { projectName, name: fileName },
        { $set: updateData },
        { returnDocument: "after" }
      );

      if (result) {
        // Mettre à jour les statistiques du projet
        await this.updateProjectStats(projectName);
      }

      return result ? this.mongoDocumentToFile(result) : null;
    } catch (error) {
      throw new StorageError(
        `Failed to update file ${fileName} in project ${projectName}`,
        error as Error
      );
    }
  }  async deleteFile(projectName: string, fileName: string): Promise<boolean> {
    try {
      const result = await this.collection.deleteOne({
        projectName,
        name: fileName,
      });

      const deleted = result.deletedCount > 0;

      if (deleted) {
        // Delete version history if versioning is enabled
        if (this.fileVersionRepository) {
          try {
            await this.fileVersionRepository.deleteAllVersions(projectName, fileName);
          } catch (versionError) {
            console.warn(`Failed to delete versions for ${fileName}:`, versionError);
          }
        }
        
        // Mettre à jour les statistiques du projet
        await this.updateProjectStats(projectName);
      }

      return deleted;
    } catch (error) {
      throw new StorageError(
        `Failed to delete file ${fileName} from project ${projectName}`,
        error as Error
      );
    }
  }

  async searchFiles(projectName: string, query: string): Promise<File[]> {
    try {
      const searchResults = await this.collection
        .find({
          projectName,
          $text: { $search: query },
        })
        .sort({ score: { $meta: "textScore" } })
        .limit(50)
        .toArray();

      return searchResults.map((file) => this.mongoDocumentToFile(file));
    } catch (error) {
      throw new StorageError(
        `Failed to search files in project ${projectName}`,
        error as Error
      );
    }
  }

  async getFilesByTags(projectName: string, tags: string[]): Promise<File[]> {
    try {
      const files = await this.collection
        .find({
          projectName,
          "metadata.tags": { $in: tags },
        })
        .sort({ updatedAt: -1 })
        .toArray();

      return files.map((file) => this.mongoDocumentToFile(file));
    } catch (error) {
      throw new StorageError(
        `Failed to get files by tags in project ${projectName}`,
        error as Error
      );
    }
  }

  async getProjectStats(
    projectName: string
  ): Promise<{ fileCount: number; totalSize: number }> {
    try {
      const stats = await this.collection
        .aggregate([
          { $match: { projectName } },
          {
            $group: {
              _id: null,
              fileCount: { $sum: 1 },
              totalSize: { $sum: "$size" },
            },
          },
        ])
        .toArray();

      return stats.length > 0
        ? { fileCount: stats[0].fileCount, totalSize: stats[0].totalSize }
        : { fileCount: 0, totalSize: 0 };
    } catch (error) {
      throw new StorageError(
        `Failed to get project stats for ${projectName}`,
        error as Error
      );
    }
  }
  // Méthode pour mettre à jour les statistiques d'un projet
  private async updateProjectStats(projectName: string): Promise<void> {
    try {
      const stats = await this.getProjectStats(projectName);

      if (this.projectRepository) {
        await this.projectRepository.updateProjectStats(
          projectName,
          stats.fileCount,
          stats.totalSize
        );
      }
    } catch (error) {
      console.warn(`Failed to update project stats for ${projectName}:`, error);
      // Ne pas faire échouer l'opération principale si la mise à jour des stats échoue
    }
  }
}
