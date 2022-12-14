import * as aws from "aws-sdk";
import * as dotenv from "dotenv";
import * as path from 'path';
import needle from 'needle';
import search from 'approx-string-match'
import { ClinicalDataExtraction } from '../interfaces/clinical.nlp.types';
import { IClinicalNLPProvider } from '../interfaces/clinical.nlp.interface';
import { Helper } from '../../../common/helper';
////////////////////////////////////////////////////////////////////////

export class ClinicalNLP_AWS implements IClinicalNLPProvider {
    private _phiEntities: any[] = [];
    private _icd10Entites: any[] = [];
    private _rxEntities: any[] = [];
    private _detectedEntities: any[] = [];
    private _text: string = null;

    constructor() {}

    public async extract(
        text: string
    ): Promise<ClinicalDataExtraction.Extraction> {
        try {
            this._text = text;
            var detections = await this.detectEntities();
            if (!detections) {
                throw new Error('Unable to detect!');
            }
            this._detectedEntities = detections.Entities;

            this._rxEntities = (await this.inferRXNorm()).Entities;
            this._icd10Entites = (await this.inferICD10CM()).Entities;
            this._phiEntities = (await this.detectPHI()).Entities;

            var extraction = await this.construct();
            return extraction;
        } catch (error) {
            console.log('Error: ' + error.message);
            throw error;
        }
    }

    private getComprehendMedical = () => {
        var cm = new aws.ComprehendMedical({
            accessKeyId: process.env.RESOURCES_S3_BUCKET_ACCESS_KEY_ID,
            secretAccessKey: process.env.RESOURCES_S3_BUCKET_ACCESS_KEY_SECRET,
            region: 'us-west-2',
        });
        return cm;
    };

    private inferICD10CM = (): Promise<any> => {
        return new Promise((resolve, reject) => {
            try {
                var cm = this.getComprehendMedical();
                var params = { Text: this._text };
                cm.inferICD10CM(params, function (err, data) {
                    if (err) {
                        reject(err);
                        console.log(err, err.stack);
                    } else {
                        console.log(data);
                        resolve(data);
                    }
                });
            } catch (error) {
                console.log(error);
                reject(error);
            }
        });
    };

    private inferRXNorm = (): Promise<any> => {
        return new Promise((resolve, reject) => {
            try {
                var cm = this.getComprehendMedical();
                var params = { Text: this._text };
                cm.inferRxNorm(params, function (err, data) {
                    if (err) {
                        reject(err);
                        console.log(err, err.stack);
                    } else {
                        console.log(data);
                        resolve(data);
                    }
                });
            } catch (error) {
                console.log(error);
                reject(error);
            }
        });
    };

    private detectPHI = (): Promise<any> => {
        return new Promise((resolve, reject) => {
            try {
                var cm = this.getComprehendMedical();
                var params = { Text: this._text };
                cm.detectPHI(params, function (err, data) {
                    if (err) {
                        reject(err);
                        console.log(err, err.stack);
                    } else {
                        console.log(data);
                        resolve(data);
                    }
                });
            } catch (error) {
                console.log(error);
                reject(error);
            }
        });
    };

    private detectEntities = (): Promise<any> => {
        return new Promise((resolve, reject) => {
            try {
                var cm = this.getComprehendMedical();
                var params = { Text: this._text };
                cm.detectEntitiesV2(params, function (err, data) {
                    if (err) {
                        reject(err);
                        console.log(err, err.stack);
                    } else {
                        console.log(data);
                        resolve(data);
                    }
                });
            } catch (error) {
                console.log(error);
                reject(error);
            }
        });
    };

    private construct = async (): Promise<ClinicalDataExtraction.Extraction> => {
        return new Promise((resolve, reject) => {
            try {
                var relations: ClinicalDataExtraction.Relation[] = [];

                var clinicalRelations = this.constructClinicalRelations();
                relations.push(...clinicalRelations);

                var phiRelations = this.constructPHIRelations();
                relations.push(...phiRelations);

                ``;
                var extraction: ClinicalDataExtraction.Extraction = new ClinicalDataExtraction.Extraction();
                extraction.relations = relations;

                resolve(extraction);
            } catch (error) {
                console.log('Error: ' + error.message);
                throw error;
            }
        });
    };

    //Reference: https://docs.aws.amazon.com/comprehend/latest/dg/extracted-med-info.html
    private classifyEntity = (
        detectedCategory: string,
        detectedEntityType: string,
        traits
    ): any => {

        var category: string = ClinicalDataExtraction.Categories.Unidentified;
        var type: string = 'Unidentified';
        var isNegated: boolean = false;
        var traitNames: string[] = [];
    
        try {

            if (traits.length > 0) {
                traitNames = traits.map((x) => x.Name);
            }
            if (traitNames.includes('NEGATION')) {
                isNegated = true;
            }
            if (detectedCategory === 'TEST_TREATMENT_PROCEDURE') {
                if (detectedEntityType === 'TEST_NAME') {
                    category = ClinicalDataExtraction.Categories.ClinicalTest;
                    type =
                        ClinicalDataExtraction.ClinicalTestAttributes.TestName;
                }
                if (detectedEntityType === 'TEST_VALUE') {
                    category = ClinicalDataExtraction.Categories.ClinicalTest;
                    type =
                        ClinicalDataExtraction.ClinicalTestAttributes.TestValue;
                }
                if (detectedEntityType === 'TEST_UNIT') {
                    category = ClinicalDataExtraction.Categories.ClinicalTest;
                    type =
                        ClinicalDataExtraction.ClinicalTestAttributes.TestUnit;
                }
                if (detectedEntityType === 'PROCEDURE_NAME') {
                    category = ClinicalDataExtraction.Categories.Procedure;
                }
                if (detectedEntityType === 'TREATMENT_NAME') {
                    category = ClinicalDataExtraction.Categories.Treatment;
                }
            }
            if (detectedCategory === 'MEDICAL_CONDITION') {
                category = ClinicalDataExtraction.Categories.MedicalCondition;
                if (detectedEntityType === 'DX_NAME') {
                    if (traitNames.includes('SYMPTOM')) {
                        category = 'Symptoms';
                    }
                    if (traitNames.includes('DIAGNOSIS')) {
                        category = 'Diagnosis';
                    }
                }
            }
            if (detectedCategory === 'ANATOMY') {
                category = ClinicalDataExtraction.Categories.Anatomy;
                if (detectedEntityType === 'SYSTEM_ORGAN_SITE') {
                    type = 'Organ';
                }
            }
            if (detectedCategory === 'MEDICATION') {
                category = ClinicalDataExtraction.Categories.Medication;
                if (detectedEntityType === 'BRAND_NAME') {
                    type =
                        ClinicalDataExtraction.MedicationAttributes.BrandName;
                }
                if (detectedEntityType === 'GENERIC_NAME') {
                    type =
                        ClinicalDataExtraction.MedicationAttributes.GenericName;
                }
                if (detectedEntityType === 'DOSAGE') {
                    type = ClinicalDataExtraction.MedicationAttributes.Dosage;
                }
                if (detectedEntityType === 'FORM') {
                    type =
                        ClinicalDataExtraction.MedicationAttributes.DosageUnit;
                }
                if (detectedEntityType === 'FREQUENCY') {
                    type =
                        ClinicalDataExtraction.MedicationAttributes.Frequency;
                }
                if (detectedEntityType === 'DURATION') {
                    type = ClinicalDataExtraction.MedicationAttributes.Duration;
                }
                if (detectedEntityType === 'ROUTE_OR_MODE') {
                    type = ClinicalDataExtraction.MedicationAttributes.Route;
                }
                if (detectedEntityType === 'STRENGTH') {
                    type = ClinicalDataExtraction.MedicationAttributes.Strength;
                }
                if (detectedEntityType === 'RATE') {
                    type = ClinicalDataExtraction.MedicationAttributes.Rate;
                }
            }
        } catch (error) {
            console.log(error.message);
        }
        return {
            category: category,
            type: type,
            isNegated: isNegated,
        };
    };

    //Reference: https://docs.aws.amazon.com/comprehend/latest/dg/extracted-med-info.html
    private classifyPHIEntity = (
        detectedCategory: string,
        detectedEntityType: string
    ): any => {
        var category: string = ClinicalDataExtraction.Categories.Unidentified;
        var type: string =
            ClinicalDataExtraction.ProtectedHealthInformationAttributes
                .Unidentified;

        if (detectedCategory === 'PROTECTED_HEALTH_INFORMATION') {
            category =
                ClinicalDataExtraction.Categories.ProtectedHealthInformation;

            if (detectedEntityType === 'NAME') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Name;
            }
            if (detectedEntityType === 'AGE') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Age;
            }
            if (detectedEntityType === 'DATE') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Date;
            }
            if (detectedEntityType === 'PHONE_OR_FAX') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Phone;
            }
            if (detectedEntityType === 'EMAIL') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Email;
            }
            if (detectedEntityType === 'ID') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Id;
            }
            if (detectedEntityType === 'URL') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Url;
            }
            if (detectedEntityType === 'ADDRESS') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Address;
            }
            if (detectedEntityType === 'PROFESSION') {
                type =
                    ClinicalDataExtraction.ProtectedHealthInformationAttributes
                        .Profession;
            }
        }

        return {
            category: category,
            type: type,
        };
    };

    //Get these from ICD10CM_identifiers / RXNorm_identifiers / PHI
    private extractNorms = (
        detectedEntityId: number
    ): ClinicalDataExtraction.CodedTerm[] => {
        var codedTerms: ClinicalDataExtraction.CodedTerm[] = [];

        try {
            var detectedEntity = this._detectedEntities.find((x) => {
                return detectedEntityId === x.Id;
            });

            if(!detectedEntity){
                return codedTerms;
            }

            //ICD10 norms
            for (var e of this._icd10Entites) {
                if (Helper.areStringsOverlapping(detectedEntity.Text, e.Text)) {
                    if (
                        Helper.areOffsetsOverlapping(
                            detectedEntity.BeginOffset,
                            detectedEntity.EndOffset,
                            e.BeginOffset,
                            e.EndOffset
                        )
                    ) {
                        //Found Norm
                        var identifiers = e.ICD10CMConcepts;
                        for (var i of identifiers) {
                            var ct = new ClinicalDataExtraction.CodedTerm();
                            ct.term = i.Description;
                            ct.norm_codes.push(i.Code);
                            ct.confidence = i.Score;
                            codedTerms.push(ct);
                        }
                    }
                }
            }

            //Rx norms
            for (var e of this._rxEntities) {
                if (Helper.areStringsOverlapping(detectedEntity.Text, e.Text)) {
                    if (
                        Helper.areOffsetsOverlapping(
                            detectedEntity.BeginOffset,
                            detectedEntity.EndOffset,
                            e.BeginOffset,
                            e.EndOffset
                        )
                    ) {
                        //Found Norm
                        var identifiers = e.RxNormConcepts;
                        for (var i of identifiers) {
                            var ct = new ClinicalDataExtraction.CodedTerm();
                            ct.term = i.ConceptName;
                            ct.norm_codes.push(i.ConceptId);
                            ct.confidence = i.Score;
                            codedTerms.push(ct);
                        }
                    }
                }
            }
        } catch (error) {
            console.log(error.message);
        }
        return codedTerms;
    };

    private constructClinicalRelations(): ClinicalDataExtraction.Relation[] {
        var relations: ClinicalDataExtraction.Relation[] = [];

        try {
            for (var de of this._detectedEntities) {
                var entities: ClinicalDataExtraction.Entity[] = [];

                var { category, type, isNegated } = this.classifyEntity(
                    de.Category,
                    de.Type,
                    de.Traits
                );

                //Get entities (subject and object entities)
                var subjectEntity = new ClinicalDataExtraction.Entity();

                subjectEntity.extraction_id = de.Id;
                subjectEntity.text = de.Text;
                subjectEntity.type = type;
                subjectEntity.category = category;
                subjectEntity.is_relation_object = false;
                subjectEntity.is_negated = isNegated;
                subjectEntity.begin_offset = de.BeginOffset;
                subjectEntity.end_offset = de.EndOffset;
                subjectEntity.coded_terms = this.extractNorms(de.Id);

                entities.push(subjectEntity);

                if (de.Attributes) {
                    for (var attr of de.Attributes) {
                        var {
                            attrCategory,
                            attrType,
                            isAttrNegated,
                        } = this.classifyEntity(
                            attr.Category,
                            attr.Type,
                            attr.Traits
                        );

                        var objectEntity = new ClinicalDataExtraction.Entity();

                        objectEntity.extraction_id = attr.Id;
                        objectEntity.text = attr.Text;
                        objectEntity.type = attrType;
                        objectEntity.category = attrCategory;
                        objectEntity.is_relation_object = true;
                        objectEntity.is_negated = isAttrNegated;
                        objectEntity.begin_offset = attr.BeginOffset;
                        objectEntity.end_offset = attr.EndOffset;
                        objectEntity.coded_terms = this.extractNorms(attr.Id);

                        entities.push(objectEntity);
                    }

                    var relation = new ClinicalDataExtraction.Relation();
                    relation.entities = entities;
                    relation.constructStatement();
                    relation.extractOriginalStatement(this._text);
                    relation.category = category;
                    relation.type = type;

                    relations.push(relation);
                }
            }
        } catch (error) {
            console.log(error.message);
        }
        return relations;
    }

    private constructPHIRelations(): ClinicalDataExtraction.Relation[] {
        var relations: ClinicalDataExtraction.Relation[] = [];

        for (var de of this._phiEntities) {
            var entities: ClinicalDataExtraction.Entity[] = [];

            var { category, type } = this.classifyPHIEntity(
                de.Category,
                de.Type
            );

            //Get entities (subject and object entities)
            var subjectEntity = new ClinicalDataExtraction.Entity();

            subjectEntity.extraction_id = de.Id;
            subjectEntity.text = de.Text;
            subjectEntity.type = type;
            subjectEntity.is_relation_object = false;
            subjectEntity.begin_offset = de.BeginOffset;
            subjectEntity.end_offset = de.EndOffset;

            entities.push(subjectEntity);

            //For PHI, create a single relation per entity
            var relation = new ClinicalDataExtraction.Relation();
            relation.entities = entities;
            relation.constructStatement();
            relation.extractOriginalStatement(this._text);
            relation.category = category;
            relation.type = type;

            relations.push(relation);
        }

        return relations;
    }
}
