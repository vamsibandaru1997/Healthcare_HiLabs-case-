import * as path from 'path';
import { google } from 'googleapis';
const healthcare = google.healthcare('v1');
import needle from 'needle';
import search from 'approx-string-match';
import { ClinicalDataExtraction } from '../interfaces/clinical.nlp.types';
import { IClinicalNLPProvider } from '../interfaces/clinical.nlp.interface';
import { Helper } from '../../../common/helper';
////////////////////////////////////////////////////////////////////////
const CONFIDENCE_THRESHOLD: number = 0.9;
////////////////////////////////////////////////////////////////////////

export class ClinicalNLP_GCP implements IClinicalNLPProvider {

    private _text: string = null;

    constructor(){
    }

    public async extract(
        text: string
    ): Promise<ClinicalDataExtraction.Extraction> {
        try {
            this._text = text;
            var detections = await this.detect();
            var relations = await this.construct(detections);
            return relations;
        } catch (error) {
            console.log('Error: ' + error.message);
            throw error;
        }
    }

    private detect = async () => {
        // curl -X POST \
        //   -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
        //   -H "Content-Type: application/json; charset=utf-8" \
        //   --data "{
        //     'nlpService': 'projects/PROJECT_ID/locations/LOCATION/services/nlp',
        //     'documentContent': 'Insulin regimen human 5 units IV administered.'
        // }" "https://healthcare.googleapis.com/v1beta1/projects/PROJECT_ID/locations/LOCATION/services/nlp:analyzeEntities"

        const projectId:string = process.env.GCP_PROJECT_ID;
        const cloudRegion:string = process.env.GCP_NLP_CLOUD_REGION;

        var token: string = await this.getAuthToken();

        token = token.replace('\r', '');
        token = token.replace('\n', '');

        var url = `https://healthcare.googleapis.com/v1beta1/projects/${projectId}/locations/${cloudRegion}/services/nlp:analyzeEntities`;
        var body = {
            nlpService: `projects/${projectId}/locations/${cloudRegion}/services/nlp`,
            documentContent: this._text,
        };
        var headers = Helper.getSessionHeaders(token);
        var options = Helper.getNeedleOptions(headers);
        var results = {};
        var response = await needle('post', url, body, options);
        if (response.statusCode == 200) {
            results = response.body;
            //console.log('Successfully detected entities!');
        } else {
            console.log('Error code: ' + response.statusCode);
        }
        return results;
    };

    private construct = async (detections): Promise<ClinicalDataExtraction.Extraction> => {

        return new Promise((resolve, reject) => {
            try {

                var relations: ClinicalDataExtraction.Relation [] = [];

                if (detections == null) {
                    throw new Error('Invalid extractions data!');
                }

                let entityMentions = detections.entityMentions;
                let entities = detections.entities;
                let relationships = detections.relationships;
                let handledMentionIds: string[] = [];

                for (var mention of entityMentions) {
                    if (handledMentionIds.includes(mention.mentionId)) {
                        continue;
                    }
                    var cluster = this.getConnectionCluster(
                        mention.mentionId,
                        relationships,
                        entityMentions,
                        entities
                    );
                    for (var element of cluster) {
                        handledMentionIds.push(element.extraction_id);
                    }
                    var relation: ClinicalDataExtraction.Relation = this.constructRelation(
                        cluster
                    );
                    relations.push(relation);
                }

                
                var extraction: ClinicalDataExtraction.Extraction = new ClinicalDataExtraction.Extraction();
                extraction.relations = relations;
                
                resolve(extraction);
            } catch (error) {
                console.log('Error: ' + error.message);
                throw error;
            }
        });
    };

    private getConnectionCluster = (
        mentionId: string,
        relationships,
        entityMentions,
        entities
    ): ClinicalDataExtraction.Entity[] => {
        var cluster: ClinicalDataExtraction.Entity[] = [];

        var currentMention = entityMentions.find((x) => {
            return x.mentionId === mentionId;
        });
        var m = this.constructEntityMention(currentMention, entities, false);
        cluster.push(m);

        for (var relation of relationships) {
            if(relation.confidence < CONFIDENCE_THRESHOLD) {
                //If the confidence is low, discard the relation
                continue;
            }
            if (mentionId === relation.subjectId) {
                var otherMention = entityMentions.find((x) => {
                    return x.mentionId === relation.objectId;
                });
                cluster.push(
                    this.constructEntityMention(otherMention, entities, true)
                );
                m.is_relation_object = false;
            } else if (mentionId === relation.objectId) {
                var otherMention = entityMentions.find((x) => {
                    return x.mentionId === relation.subjectId;
                });
                cluster.push(
                    this.constructEntityMention(otherMention, entities, false)
                );
                m.is_relation_object = true;
            }
        }
        return cluster;
    };

    private constructRelation(cluster: ClinicalDataExtraction.Entity[]): ClinicalDataExtraction.Relation {
        if (cluster.length == 0) {
            return null;
        }
        cluster.sort((a, b) => {
            if (a.is_relation_object && !b.is_relation_object) {
                return 1;
            }
            return -1;
        });

        var texts = cluster.map((x) => x.text);
        var contextSubject = cluster[0].context_subject;
        var category = cluster[0].category;
        var type = cluster[0].type;

        var relation = new ClinicalDataExtraction.Relation();
        relation.entities = cluster;
        relation.context_subject = contextSubject;
        relation.category = category;
        relation.type = type;
        relation.keywords = [];
        relation.constructStatement();
        relation.extractOriginalStatement(this._text);

        return relation;
    }

    private constructEntityMention = (
        mention,
        detectedEntities,
        is_relation_object
    ): ClinicalDataExtraction.Entity => {

        var codedTerms: ClinicalDataExtraction.CodedTerm[] = [];

        if (mention.linkedEntities) {

            for (var linkedEntity of mention.linkedEntities) {

                var de = detectedEntities.find((x) => {
                    return x.entityId === linkedEntity.entityId;
                });
                if (de) {
                    var codedTerm = new ClinicalDataExtraction.CodedTerm();
                    codedTerm.term = de.preferredTerm;
                    codedTerm.norm_codes = de.vocabularyCodes;
                    codedTerm.nlp_system_entity_code = de.entityId;
                    codedTerms.push(codedTerm);
                }
            }
        }

        var contextSubject = mention.subject ? mention.subject.value : null;
        var { category, type } = this.classifyEntity(mention.type);
        
        var entity = new ClinicalDataExtraction.Entity();

        entity.extraction_id = mention.mentionId;
        entity.text = mention.text.content;
        entity.type = type;
        entity.category = category;
        entity.coded_terms = codedTerms;
        entity.context_subject = this.getContextSubject(contextSubject);
        entity.is_relation_object = is_relation_object;
        entity.begin_offset = mention.text.beginOffset ? mention.text.beginOffset : 0;
        entity.end_offset = entity.begin_offset + mention.text.content.length;

        return entity;
    };

    private getContextSubject = (contextSubject: string) => {
        if(contextSubject == null){
            return ClinicalDataExtraction.ContextSubject.Default;
        }
        if(contextSubject == 'PATIENT') {
            return ClinicalDataExtraction.ContextSubject.Patient;
        }
        if(contextSubject == 'FAMILY_MEMBER') {
            return ClinicalDataExtraction.ContextSubject.Family;
        }
        if(contextSubject == 'OTHER') {
            return ClinicalDataExtraction.ContextSubject.Other;
        }
        return ClinicalDataExtraction.ContextSubject.Default;
    }

    private getAuthToken = async (): Promise<string> => {
        try {
            const token: string = await Helper.executeCommand(
                'gcloud auth application-default print-access-token'
            );
            //console.log(token);
            return token;
        } catch (error) {
            console.error(error.toString());
        }
    };

    private classifyEntity = (mentionType: string): any => {

        var category:string = ClinicalDataExtraction.Categories.Unidentified;
        var type:string = 'Unidentified';
        var isNegated: boolean = false;

        if(mentionType === 'ANATOMICAL_STRUCTURE'){
            category = ClinicalDataExtraction.Categories.Anatomy;
            type = 'Organ'; 
        }
        if(mentionType === 'PROBLEM'){
            category = ClinicalDataExtraction.Categories.MedicalCondition;
        }
        if(mentionType === 'SEVERITY'){
            category = ClinicalDataExtraction.Categories.MedicalCondition;
            type = 'Severity'; 
        }
        if(mentionType === 'PROCEDURE'){
            category = ClinicalDataExtraction.Categories.Procedure;
            type = 'Procedure'; 
        }
        if(mentionType === 'PROC_METHOD'){
            category = ClinicalDataExtraction.Categories.Procedure;
            type = 'ProcedureMethod'; 
        }
        if(mentionType === 'PROCEDURE_RESULT'){
            category = ClinicalDataExtraction.Categories.Procedure;
            type = 'ProcedureResult'; 
        }
        if(mentionType === 'MEDICINE'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.GenericName; 
        }
        if(mentionType === 'MED_DOSE'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Dosage; 
        }
        if(mentionType === 'MED_DURATION'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Duration; 
        }
        if(mentionType === 'MED_FORM'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.DosageUnit; 
        }
        if(mentionType === 'MED_FREQUENCY'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Frequency; 
        }
        if(mentionType === 'MED_ROUTE'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Route; 
        }
        if(mentionType === 'MED_STATUS'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Status; 
        }
        if(mentionType === 'MED_STRENGTH'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.Strength; 
        }
        if(mentionType === 'MED_TOTALDOSE'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.TotalDosage; 
        }
        if(mentionType === 'MED_UNIT'){
            category = ClinicalDataExtraction.Categories.Medication;
            type = ClinicalDataExtraction.MedicationAttributes.DosageUnit; 
        }
        if(mentionType === 'LABORATORY_DATA'){
            category = ClinicalDataExtraction.Categories.ClinicalTest;
            type = ClinicalDataExtraction.ClinicalTestAttributes.TestResult; 
        }
        if(mentionType === 'LAB_RESULT'){
            category = ClinicalDataExtraction.Categories.ClinicalTest;
            type = ClinicalDataExtraction.ClinicalTestAttributes.TestResult;
        }
        if(mentionType === 'LAB_VALUE'){
            category = ClinicalDataExtraction.Categories.ClinicalTest;
            type = ClinicalDataExtraction.ClinicalTestAttributes.TestValue;
        }
        if(mentionType === 'LAB_UNIT'){
            category = ClinicalDataExtraction.Categories.ClinicalTest;
            type = ClinicalDataExtraction.ClinicalTestAttributes.TestUnit;
        }
        if(mentionType === 'BODY_MEASUREMENT'){
            category = ClinicalDataExtraction.Categories.Biometrics;
            type = ClinicalDataExtraction.BiometricsAttributes.BiometricsName; 
        }
        if(mentionType === 'BM_RESULT'){
            category = ClinicalDataExtraction.Categories.Biometrics;
            type = ClinicalDataExtraction.BiometricsAttributes.BiometricsResult; 
        }
        if(mentionType === 'BM_VALUE'){
            category = ClinicalDataExtraction.Categories.Biometrics;
            type = ClinicalDataExtraction.BiometricsAttributes.BiometricsValue; 
        }
        if(mentionType === 'BM_UNIT'){
            category = ClinicalDataExtraction.Categories.Biometrics;
            type = ClinicalDataExtraction.BiometricsAttributes.BiometricsUnit; 
        }
        if(mentionType === 'MEDICAL_DEVICE'){
            category = ClinicalDataExtraction.Categories.MedicalDevice;
            type = 'MedicalDevice'; 
        }
        if(mentionType === 'SUBSTANCE_ABUSE'){
            category = ClinicalDataExtraction.Categories.Addiction;
            type = 'SubstanceAbuse'; 
        }
        if(mentionType === 'BODY_FUNCTION'){
            category = ClinicalDataExtraction.Categories.BodyFunction;
            type = 'BodyFunction'; 
        }
        if(mentionType === 'BF_RESULT'){
            category = ClinicalDataExtraction.Categories.BodyFunction;
            type = 'BodyFunctionResult'; 
        }
        if(mentionType === 'FAMILY'){
            category = ClinicalDataExtraction.Categories.FamilyHistory;
            type = 'FamilyHistory'; 
        }
        return {
            category: category,
            type: type
        };
    };

}
