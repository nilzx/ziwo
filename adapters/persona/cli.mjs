#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Artifacts } from '../codex/continuity/experiment.mjs';
import { assessFormation, prepareFormationReview, validateFormationMaterial } from './formation.mjs';

const [command, materialPath, outputPath, reviewPath] = process.argv.slice(2);
const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
try {
  if (!['assess', 'prepare'].includes(command) || !materialPath || !outputPath || command === 'prepare' && !reviewPath) throw new Error('Usage: node adapters/persona/cli.mjs assess MATERIAL NEW_OUTPUT_DIR | prepare MATERIAL NEW_OUTPUT_DIR REVIEW');
  const material = validateFormationMaterial(await read(materialPath));
  const assessment = assessFormation(material);
  const review = command === 'prepare' ? prepareFormationReview(material, await read(reviewPath)) : null;
  await mkdir(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
  const artifacts = await Artifacts.create(resolve(outputPath));
  await artifacts.save('assessment.json', assessment);
  if (review) await artifacts.save('review.private.json', review);
  console.log(JSON.stringify({ directory: resolve(outputPath), identityId: material.identityId, inputDigest: assessment.inputDigest,
    status: assessment.status, evidence: assessment.evidence, reviewDigest: review?.reviewDigest ?? null, adoptionAuthorized: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
